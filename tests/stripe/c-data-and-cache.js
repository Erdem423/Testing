const { assertStatus, assertStatusIn, assert, assertApprox, assertEqual } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");
const { pollCacheUntilComplete } = require("../../helpers/pollCacheUntilComplete");

/**
 * Data Correctness & Cache Behavior - the merged successor to the old
 * separate `C: Data Correctness` and `D: Cache Behavior` tests.
 *
 * WHY THESE ARE ONE TEST NOW
 * Running them as two concurrent tests meant they could collide: creating a
 * cache on a table the other one was querying live made the live count come
 * back 0, because Peaka's query routing prefers an existing (even still-
 * syncing, still-empty) cache once one exists. That was previously worked
 * around by having D deliberately pick a table C never touched.
 *
 * Merging them removes the race outright - steps inside one test are plain
 * sequential awaits - and turns the interaction into the actual subject of
 * the test. The old workaround (an exclusion list, then a preferred-table
 * list) is gone; the cache targets are now exactly the tables the
 * correctness checks care about.
 *
 * THE SHAPE, AND WHY THE ORDER MATTERS
 *   Phase 1  every assertion while nothing is cached
 *   Phase 2  cache all four tables, wait for them to sync
 *   Phase 3  the same assertions again, now served from cache
 *   Phase 4  cache edge cases (non-cacheable table, duplicate creation)
 *
 * Phase 1 MUST come first. The live/uncached checks measure Peaka's ~100-row
 * COUNT(*) cap, and once a table is cached there is no live query left to
 * measure it with - the cap only applies to live pass-through reads.
 *
 * THE CAP, MEASURED ON ALL FOUR TABLES (2026-07-29)
 * Live counts come back as exactly 100 on every table, regardless of real
 * size; cached counts are correct:
 *
 *   table          live   cached
 *   customers       100     505
 *   charges         100     652
 *   subscriptions   100     222
 *   invoices        100     338
 *
 * 100 matches Stripe's default List API page size, so the likely cause is
 * that Peaka isn't paginating through all pages before aggregating. Filtered
 * counts are capped too (refunded charges: 18 live vs 85 cached - i.e. 18 of
 * the first 100 rows), which says the cap is on the underlying scan rather
 * than on the aggregate.
 *
 * Phase 1 asserting "every table returns exactly the cap" is therefore a
 * deliberate PASSING regression test - "is the cap still exactly 100?" - not
 * a check designed to fail forever. If Peaka fixes the pagination bug these
 * steps should start failing; that is the intended signal. Don't "fix" them
 * by raising EXPECTED_CUSTOMER_COUNT_NON_CACHE to match your real count.
 */

// The tables whose data these checks assert on, and therefore the tables
// this test caches. All four verified to cache cleanly (~37-50s in parallel).
const DC_TABLES = ["customers", "charges", "subscriptions", "invoices"];

// Missing seed data used to SKIP these checks, which let the scenario report
// green while verifying nothing. It is a precondition failure instead.
const SEED_HINT =
  "An empty sandbox is a precondition failure, not a pass - see the README's Prerequisites. Skipping here would let this scenario report green while verifying nothing.";

function qname(ctx, tableName) {
  return `"${ctx.catalogName}"."${ctx.schemaName}"."${tableName}"`;
}

async function countRows(ctx, tableName, whereClause = "") {
  const sql = `SELECT COUNT(*) AS cnt FROM ${qname(ctx, tableName)} ${whereClause}`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, `count(${tableName})`);
  return Number(res.body.data[0].cnt);
}

/**
 * Runs every count this test cares about and returns raw numbers. Kept free
 * of assertions on purpose - it gets called once uncached and once cached,
 * and the two passes expect legitimately different values, so the
 * expectations live in the steps rather than in here.
 */
async function measureCounts(ctx) {
  return {
    customers: await countRows(ctx, "customers"),
    charges: await countRows(ctx, "charges"),
    chargesRefunded: await countRows(ctx, "charges", "WHERE refunded = true"),
    subscriptions: await countRows(ctx, "subscriptions"),
    subsActive: await countRows(ctx, "subscriptions", "WHERE status = 'active'"),
    subsCanceled: await countRows(ctx, "subscriptions", "WHERE status = 'canceled'"),
    invoices: await countRows(ctx, "invoices"),
  };
}

/**
 * Fetches up to `limit` ids from a table. Used to test the row-retrieval form
 * of the 100-row cap, which is distinct from the COUNT(*) form: the cap is on
 * the underlying scan, so it truncates ordinary data fetches too.
 */
async function fetchIds(ctx, tableName, limit) {
  const sql = `SELECT id FROM ${qname(ctx, tableName)} LIMIT ${limit}`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, `SELECT id FROM ${tableName} LIMIT ${limit}`);
  return res.body.data.map((r) => r.id);
}

/**
 * Runs an aggregate and a raw fetch over the same table, so the two can be
 * cross-checked against each other.
 *
 * WHY THIS IS A SECOND, INDEPENDENT ROUTE TO THE 100-ROW CAP. Every other
 * assertion in this file reaches the cap through COUNT(*). This reaches it from
 * the other side: compute the total client-side from the rows a caller can
 * actually fetch, and compare. Measured live on `charges` (652 real rows):
 *
 *   aggregate:  COUNT(*)=100  SUM=633201
 *   raw rows:   100 fetched   client-side SUM=633201
 *
 * They agree, and THAT is the finding - the aggregate is computed over the same
 * truncated scan the rows come from. Until now the README asserted the cap sits
 * on the scan rather than on the aggregate, inferred from filtered counts being
 * capped too. This measures it directly.
 *
 * Number() is required because Peaka returns numeric columns as STRINGS - see
 * the shape step above and FINDINGS.md.
 */
async function aggregateVsRaw(ctx, tableName, column) {
  const agg = await ctx.client.executeQuery(
    { statement: `SELECT COUNT(*) AS cnt, SUM(${column}) AS total FROM ${qname(ctx, tableName)}` },
    "SIMPLE"
  );
  assertStatus(agg, 200, `aggregate over ${tableName}.${column}`);

  // A limit comfortably above the real row count, so the fetch is bounded by
  // the data rather than by the LIMIT.
  const rows = await ctx.client.executeQuery(
    { statement: `SELECT ${column} FROM ${qname(ctx, tableName)} LIMIT 1000` },
    "SIMPLE"
  );
  assertStatus(rows, 200, `raw ${column} values from ${tableName}`);

  const values = rows.body.data.map((r) => Number(r[column]));
  return {
    cnt: Number(agg.body.data[0].cnt),
    total: Number(agg.body.data[0].total),
    rowCount: values.length,
    rowSum: values.reduce((a, b) => a + b, 0),
  };
}

/**
 * The shared assertions for the above, run once per phase.
 *
 * `rowCount === cnt` comes FIRST and carries the weight: it proves both sides
 * saw the same scan, which is what makes comparing the sums meaningful rather
 * than a coincidence of two numbers that happen to match.
 */
function assertAggregateMatchesRaw(result, label) {
  assertEqual(
    result.rowCount,
    result.cnt,
    `${label}: rows fetched vs COUNT(*) - the aggregate and the fetch must see the same scan`
  );
  assertEqual(
    result.rowSum,
    result.total,
    `${label}: client-side SUM over the fetched rows vs the server's SUM`
  );
}

/**
 * The spot-check target, DERIVED rather than hardcoded.
 *
 * This used to look for `Test Customer 1` by name, and never found it. Live
 * reads return only the first 100 rows and Stripe lists newest-first, so the
 * window holds customers 500 down to 401 - customer 1 sits 400 rows outside it
 * and is unreachable live by construction. The step reported
 * "seed script may use a different naming pattern" and skipped, blaming the
 * seed data for this suite's own documented cap.
 *
 * Worse, it took the cached half down with it: `liveSpotCheck` stayed null, so
 * the cached step's comparison sat behind `if (liveSpotCheck)` and never ran.
 * The one assertion proving that caching does not alter field VALUES had never
 * executed.
 *
 * Taking whatever row comes back first makes the target inherently reachable -
 * it is chosen from inside the live window rather than hoped to be in it.
 */
async function fetchFirstCustomer(ctx) {
  const sql = `SELECT name, email FROM ${qname(ctx, "customers")} LIMIT 1`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, "spot check target");
  assert(
    res.body.data.length > 0,
    "No customers at all in the catalog. This suite needs a seeded Stripe sandbox - see the README's " +
      "Prerequisites. Failing rather than skipping: an empty sandbox means the assertions below would " +
      "verify nothing while still reporting green."
  );
  return res.body.data[0];
}

/** Looks up one customer by exact name. Returns the row, or null if absent. */
async function fetchCustomerByName(ctx, name) {
  const sql = `SELECT name, email FROM ${qname(ctx, "customers")} WHERE name = '${name}' LIMIT 1`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, `spot check customer '${name}'`);
  return res.body.data.length > 0 ? res.body.data[0] : null;
}

/**
 * Checks the email belongs to THIS customer rather than merely being present.
 *
 * Seeded emails look like `test.customer500.<timestamp>@example.com`, so the
 * number in the name must appear in the address. That catches rows being
 * stitched together wrongly, which a "the email is non-empty" check would not.
 *
 * The convention check stands down for names that don't match the seed pattern,
 * but the caller's live-vs-cached comparison always runs - the conditional is on
 * NAMING, never on data being present.
 */
function assertEmailBelongsTo(row, label) {
  assert(
    typeof row.email === "string" && row.email.includes("@"),
    `Expected ${label} to have an email address, got: ${JSON.stringify(row.email)}`
  );
  const match = /^Test Customer (\d+)$/.exec(row.name || "");
  if (!match) {
    console.log(`note: '${row.name}' doesn't match the seed naming pattern, so the email convention check is skipped`);
    return;
  }
  assert(
    row.email.includes(`customer${match[1]}.`),
    `Email does not belong to ${label}: name '${row.name}' should map to an address containing ` +
      `'customer${match[1]}.', got '${row.email}'`
  );
}

async function runDataAndCache(ctx) {
  // Populated as the test progresses; the comparison step reads both.
  let live = null;
  let cached = null;
  let liveSpotCheck = null;

  // Set if the tables are already cached when we start (leftover from
  // SKIP_CLEANUP=true, or a cleanup that failed). The live phase is
  // meaningless then, so it gets skipped rather than failing the run - a
  // dirty environment is a precondition problem, not a product bug.
  let skipLivePhase = false;

  // ---------------------------------------------------------------- Phase 1

  await step("resolve catalog name", async () => {
    await resolveCatalogName(ctx);
  });

  await step("data-correctness tables all start uncached", async () => {
    assert(ctx.catalogId, "Requires PEAKA_CATALOG_ID to be set in .env");
    assert(ctx.schemaName, "Requires PEAKA_SCHEMA_NAME to be set in .env");

    const check = async () => {
      const cached = [];
      for (const tableName of DC_TABLES) {
        const res = await ctx.client.isTableCached(ctx.catalogId, ctx.schemaName, tableName);
        assertStatus(res, 200, `isCached(${tableName})`);
        if (res.body.isCached === true) cached.push(tableName);
      }
      return cached;
    };

    let alreadyCached = await check();

    // CORRUPTION DETECTOR. A table reporting isCached:true while NO cache is
    // listed for the catalog is a contradiction Peaka should never produce,
    // and it is the exact signature of an unrecoverable state hit on
    // 2026-07-31 (see the README's "Deleting a cache can permanently break a
    // table"): the table could not be queried (400, pointing at a dropped
    // Iceberg table), could not be re-cached (400, "non-empty location"), and
    // exposed no cache id to delete. No API-side repair exists.
    //
    // Six attempts to reproduce it deliberately all failed - delete mid-sync,
    // repeated normal cycles, immediate delete, the mid-sync duplicate-create
    // 500, concurrent delete+create, and concurrent creates - so this cannot
    // be a reproduction test. Detection is what's achievable, and it is worth
    // having: without it the corruption surfaced ~40s later as an opaque
    // Iceberg error from createCache, several steps removed from the cause.
    if (alreadyCached.length > 0) {
      const listed = await ctx.client.getAllCacheStatusesOfCatalog(ctx.catalogId);
      assertStatus(listed, 200, "getAllCacheStatusesOfCatalog");
      const listedTables = new Set((listed.body || []).map((entry) => entry.tableName));
      const phantom = alreadyCached.filter((t) => !listedTables.has(t));
      assert(
        phantom.length === 0,
        `CORRUPTED CACHE STATE: [${phantom.join(", ")}] report isCached:true but no cache is listed for ` +
          `this catalog. That combination is unrecoverable through the API - the table cannot be queried ` +
          `or re-cached, and there is no cache id to delete. Repair it in Peaka Studio (recreating the ` +
          `catalog entry works; the same table caches fine in a fresh catalog). See the README's ` +
          `"Deleting a cache can permanently break a table" for the full diagnosis.`
      );
    }

    // SELF-HEAL RATHER THAN SILENTLY SKIP.
    //
    // This used to just set skipLivePhase and print a note, which disabled
    // EIGHT downstream steps - including the 100-row cap regression and the
    // SELECT...LIMIT 500 assertion, the two most valuable checks in the file.
    // The scenario still reported green. That is not hypothetical: a dashboard
    // server died mid-run, left all four tables cached, and the next run
    // quietly verified almost nothing.
    //
    // Leftover caches are debris, not a legitimate state, so clear them and
    // run the real thing. createCache is get-or-create, so it hands back the
    // existing cache to delete. skipLivePhase now only survives if remediation
    // genuinely fails.
    if (alreadyCached.length > 0) {
      console.log(
        `[${alreadyCached.join(", ")}] were already cached before this run (leftover from SKIP_CLEANUP=true, ` +
          `an interrupted run, or a concurrent suite). Clearing them so the live phase can actually run.`
      );
      for (const tableName of alreadyCached) {
        const existing = await ctx.client.createCache({
          catalogId: ctx.catalogId,
          schemaName: ctx.schemaName,
          tableName,
        });
        if (existing.status === 200 && existing.body && existing.body.id) {
          // Can't delete a cache mid-sync, so let it settle first.
          await pollCacheUntilComplete(ctx, existing.body.id).catch(() => {});
          const del = await ctx.client.deleteCache(existing.body.id);
          console.log(`  cleared ${tableName} -> deleteCache ${del.status}`);
        }
      }
      alreadyCached = await check();
    }

    if (alreadyCached.length > 0) {
      skipLivePhase = true;
      console.log(
        `WARNING: [${alreadyCached.join(", ")}] are STILL cached after remediation, so the live/uncached ` +
          `phase cannot run - a cached table cannot measure the live cap. The steps below will report as ` +
          `skipped and this run verifies substantially less than usual. Delete those caches in Peaka Studio.`
      );
    }
  });

  // VALUE-SHAPE VALIDATION, which nothing in this suite did before. Every other
  // assertion here is about how MANY rows come back; this is the only one about
  // whether the rows are shaped as asked for.
  //
  // DELIBERATELY NOT BEHIND skipLivePhase. Shape does not depend on whether
  // anything is cached, and gating it would recreate the silent-skip problem
  // that already affects the field-level spot check below - a step that reports
  // green having verified nothing.
  //
  // LIMIT 3 keeps this far under the 100-row cap, so it needs no cache and says
  // nothing about the cap either way.
  await step("a SELECT returns the requested columns with correctly-shaped values", async () => {
    const sql = `SELECT id, amount FROM ${qname(ctx, "charges")} LIMIT 3`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatus(res, 200, "SELECT id, amount FROM charges");

    // Names AND order. A connector that silently reordered or renamed columns
    // would still return plausible-looking data.
    const returned = (res.body.columns || []).map((c) => c.columnName);
    assertEqual(
      JSON.stringify(returned),
      JSON.stringify(["id", "amount"]),
      "returned column names (order matters)"
    );

    assert(res.body.data.length > 0, "Expected at least one charge row - has the seed script run?");
    for (const row of res.body.data) {
      // Stripe ids are prefixed per object type; `ch_` is the charge prefix.
      // This catches a join or routing bug returning the wrong table's rows,
      // which a count-based assertion never would.
      assert(
        typeof row.id === "string" && /^ch_/.test(row.id),
        `Expected charge ids to start with 'ch_', got: ${JSON.stringify(row.id)}`
      );
      // Exactly the requested keys - no more. A silently widened response is a
      // contract change worth noticing.
      assertEqual(
        JSON.stringify(Object.keys(row).sort()),
        JSON.stringify(["amount", "id"]),
        "returned row keys"
      );
      // PINS A KNOWN QUIRK: Peaka returns numeric columns as STRINGS ("15000",
      // not 15000). Any caller doing arithmetic on this gets string
      // concatenation instead. Asserted rather than tolerated so that if Peaka
      // starts returning real numbers this step goes red and someone updates
      // the finding - the same deliberate passing-regression-test approach used
      // for the 100-row cap above. See FINDINGS.md.
      assert(
        typeof row.amount === "string",
        `Expected 'amount' to come back as a string (Peaka's documented-here quirk), got ` +
          `${typeof row.amount}: ${JSON.stringify(row.amount)}. If Peaka now returns numbers, that is an ` +
          `improvement - update this assertion and FINDINGS.md rather than loosening it.`
      );
    }
    console.log(`shape check: columns [${returned.join(", ")}], ids prefixed 'ch_', amount typed as string`);
  });

  await step("live: the aggregate matches a total computed from the fetched rows", async () => {
    if (skipLivePhase) {
      note("skipped: tables were already cached");
      return;
    }
    const r = await aggregateVsRaw(ctx, "charges", "amount");
    assertAggregateMatchesRaw(r, "live charges");

    // The cap, reached from a different direction than the COUNT(*) steps.
    // Both sides being capped is exactly why they agree.
    assertEqual(
      r.cnt,
      ctx.expectedCustomerCountNonCache,
      "live COUNT(*) on charges (expected the cap)"
    );
    console.log(
      `live charges: COUNT(*)=${r.cnt}, SUM=${r.total}; ${r.rowCount} rows fetched summing to ${r.rowSum} - ` +
        `the aggregate is computed over the same truncated scan`
    );
  });

  await step("live counts are capped at 100 on every table", async () => {
    if (skipLivePhase) {
      note("skipped: tables were already cached (see previous step)");
      return;
    }
    live = await measureCounts(ctx);
    liveSpotCheck = await fetchFirstCustomer(ctx);

    // Every one of these is expected to be exactly the cap, not the real
    // count - see the module comment. Tolerance stays tight (10%) because
    // the cap value itself is exact; it's the real counts that vary.
    for (const tableName of DC_TABLES) {
      assertApprox(live[tableName], ctx.expectedCustomerCountNonCache, 0.1, `live ${tableName} count (expected the cap)`);
    }
  });

  // THE ROW-RETRIEVAL FORM OF THE CAP, and the most consequential assertion
  // in this file. The COUNT(*) steps above catch the aggregate symptom; this
  // catches the one that actually corrupts data for a caller: an ordinary
  // SELECT silently returns a PARTIAL result set with no error and no flag.
  //
  // Measured on `charges` (652 real rows, uncached): LIMIT 150, 250 and 500
  // all return exactly 100, through both the statement and builder request
  // types. Anything built on a live query is reading truncated data and
  // cannot tell.
  //
  // Like the count checks, this asserts the KNOWN CAP so it passes today and
  // goes red if Peaka fixes the pagination bug - that's the intended signal.
  await step("a live SELECT cannot return more than 100 rows", async () => {
    if (skipLivePhase) {
      note("skipped: tables were already cached (see earlier step)");
      return;
    }
    const cap = ctx.expectedCustomerCountNonCache;
    const ids = await fetchIds(ctx, "charges", 500);
    assert(
      ids.length === cap,
      `Expected a live SELECT with LIMIT 500 to still return exactly ${cap} rows (the known cap), got ${ids.length}. ` +
        `If this is now returning the full table, Peaka has fixed the pagination bug - update this step and the ` +
        `README's "Known gaps" rather than loosening the assertion.`
    );
    assert(
      new Set(ids).size === ids.length,
      `Expected no duplicate ids within a single page, got ${ids.length - new Set(ids).size} duplicates`
    );
  });

  await step("live charge refund distribution is plausible", async () => {
    if (skipLivePhase) {
      note("skipped: tables were already cached");
      return;
    }
    assert(live.charges > 0, `No charges visible. ${SEED_HINT}`);
    // AN INVARIANT, NOT A RATIO. This used to assert ~15% refunded, which
    // encoded one particular seed's shape and would fail on any other account
    // while saying nothing about Peaka. What actually matters is that the
    // `WHERE refunded = true` filter discriminates: not everything, not
    // nothing. That holds on any account with mixed data, and still catches a
    // filter that silently matches every row or none.
    assert(
      live.chargesRefunded > 0 && live.chargesRefunded < live.charges,
      `Expected the refunded filter to match some but not all charges, got ` +
        `${live.chargesRefunded} refunded of ${live.charges} total. Equal to 0 means the filter matched ` +
        `nothing; equal to the total means it did not filter at all.`
    );
  });

  await step("live subscription status distribution is sane", async () => {
    if (skipLivePhase) {
      note("skipped: tables were already cached");
      return;
    }
    assert(live.subscriptions > 0, `No subscriptions visible. ${SEED_HINT}`);
    assert(live.subsActive + live.subsCanceled > 0, "Expected some active or canceled subscriptions");
    assert(
      live.subsActive + live.subsCanceled <= live.subscriptions,
      "active+canceled should not exceed total subscriptions"
    );
  });

  await step("live field-level spot check on a specific seeded customer", async () => {
    if (skipLivePhase) {
      note("skipped: tables were already cached");
      return;
    }
    // No "not found" guard any more: the target is whatever the live query
    // returned first, so it exists by construction. fetchFirstCustomer already
    // failed loudly if the catalog held no customers at all.
    assert(liveSpotCheck, "Expected the live phase to have chosen a spot-check target");
    assertEmailBelongsTo(liveSpotCheck, "the live spot-check customer");
    console.log(`live spot check on '${liveSpotCheck.name}' (${liveSpotCheck.email})`);
  });

  // ---------------------------------------------------------------- Phase 2

  await step("create caches on all data-correctness tables", async () => {
    for (const tableName of DC_TABLES) {
      const res = await ctx.client.createCache({
        catalogId: ctx.catalogId,
        schemaName: ctx.schemaName,
        tableName,
      });
      // 200 covers both "created" and Peaka's real get-or-create behavior for
      // a table that already has a cache (see the duplicate-creation step).
      assertStatusIn(res, [200, 409], `createCache(${tableName})`);
      assert(res.body && res.body.id, `Expected cache id in createCache(${tableName}) response`);
      ctx.createdCacheIds.push(res.body.id);
    }
  });

  await step("all caches reach a completed sync", async () => {
    // Polled together rather than one after another - four sequential polls
    // would cost the sum of the sync times instead of the slowest one
    // (measured: ~37s each, ~50s for invoices, ~50s total in parallel).
    await Promise.all(ctx.createdCacheIds.map((cacheId) => pollCacheUntilComplete(ctx, cacheId)));
  });

  await step("data-correctness tables now report isCached", async () => {
    for (const tableName of DC_TABLES) {
      const res = await ctx.client.isTableCached(ctx.catalogId, ctx.schemaName, tableName);
      assertStatus(res, 200, `isCached(${tableName})`);
      assert(
        res.body.isCached === true,
        `Expected ${tableName} to report isCached:true after its cache completed, got ${JSON.stringify(res.body)}`
      );
    }
  });

  // ---------------------------------------------------------------- Phase 3

  await step("cached counts bypass the 100-row cap on every table", async () => {
    cached = await measureCounts(ctx);
    for (const tableName of DC_TABLES) {
      assert(
        cached[tableName] !== ctx.expectedCustomerCountNonCache,
        `${tableName} still returns exactly ${ctx.expectedCustomerCountNonCache} when served from cache - ` +
          `the cap appears to affect cached reads too, which would make it broader than a live-query ` +
          `pagination bug. That's a real finding either way, don't loosen this.`
      );
      assert(cached[tableName] > 0, `Expected a non-zero cached count for ${tableName}`);
    }
  });

  // The mirror of the live row-cap check. Caching must lift the cap for
  // ordinary row retrieval, not just for COUNT(*) - otherwise the truncation
  // would be reaching cached reads too, which would make it far broader than
  // a live pass-through pagination bug.
  //
  // This is also the only place the suite exercises the spec's "pagination
  // beyond Stripe's page size" case, since it's the only context where a
  // >100-row result is actually obtainable.
  await step("a cached SELECT returns more than 100 rows", async () => {
    const cap = ctx.expectedCustomerCountNonCache;
    const ids = await fetchIds(ctx, "charges", 500);
    assert(
      ids.length > cap,
      `Expected a cached SELECT with LIMIT 500 to exceed the ${cap}-row live cap, got ${ids.length}. ` +
        `If this equals the cap, the truncation affects cached reads too - a materially bigger bug. ` +
        `Don't loosen this.`
    );
    assert(
      new Set(ids).size === ids.length,
      `Expected no duplicate ids across a >100-row cached page, got ${ids.length - new Set(ids).size} duplicates`
    );
    console.log(`cached SELECT ... LIMIT 500 returned ${ids.length} rows (live returns exactly ${cap})`);
  });

  await step("cached customer count matches the real seeded count", async () => {
    // ASKS STRIPE, NOT .env.
    //
    // This used to compare against NUM_CUSTOMERS - a number typed into .env by
    // hand. That made the suite unrunnable for anyone else: a colleague's
    // account has a different number, so this failed against a perfectly
    // healthy Peaka and looked like a product bug.
    //
    // The question is "does Peaka's cached view match reality?", and reality is
    // Stripe. Asking the source directly is portable AND a stronger claim, so
    // the tolerance is tight rather than the old +/-10%: these should agree
    // exactly, and any real drift is worth seeing.
    //
    // The small allowance that remains covers a customer created by a
    // concurrently-running scenario (O writes to Stripe) landing between the
    // cache sync and this count.
    // THE ONLY STEP IN C THAT TALKS TO STRIPE DIRECTLY. Everything else in
    // this scenario goes through Peaka, so one missing token should cost this
    // comparison and nothing more - see helpers/buildCtx.js.
    if (!ctx.stripe) {
      note(
        `skipped: no STRIPE_TEST_TOKEN, so the cached count (${cached.customers}) cannot be compared against ` +
          `Stripe's own. Every other check in this scenario still ran.`
      );
      return;
    }
    const stripeTotal = await ctx.stripe.countCustomers();
    assert(
      stripeTotal > 0,
      `Stripe reports 0 customers, so there is nothing for the cache to match. ${SEED_HINT}`
    );
    const drift = Math.abs(cached.customers - stripeTotal);
    assert(
      drift <= 2,
      `Cached customer count is ${cached.customers} but Stripe itself reports ${stripeTotal} ` +
        `(difference ${drift}). The cache and the source disagree.`
    );
    console.log(`cached ${cached.customers} vs Stripe's own count ${stripeTotal}`);
  });

  await step("cached charge refund distribution is plausible", async () => {
    assert(cached.charges > 0, `No charges in the cached table. ${SEED_HINT}`);
    // Same invariant as the live pass (see there for why it is not a ratio),
    // but measured over the full table rather than a capped 100-row sample.
    assert(
      cached.chargesRefunded > 0 && cached.chargesRefunded < cached.charges,
      `Expected the refunded filter to match some but not all cached charges, got ` +
        `${cached.chargesRefunded} refunded of ${cached.charges} total.`
    );
  });

  await step("cached subscription status distribution is sane", async () => {
    assert(cached.subscriptions > 0, `No subscriptions in the cached table. ${SEED_HINT}`);
    assert(cached.subsActive + cached.subsCanceled > 0, "Expected some active or canceled subscriptions");
    assert(
      cached.subsActive + cached.subsCanceled <= cached.subscriptions,
      "active+canceled should not exceed total subscriptions"
    );
  });

  await step("cached invoice count is consistent with subscriptions", async () => {
    assert(cached.invoices > 0, `No invoices in the cached table. ${SEED_HINT}`);
    // REPLACED ASSERTION, worth reading before "fixing" this back.
    //
    // This used to assert invoices ~= 25% of the customer count. That only
    // ever passed because BOTH numbers were being clamped to the cap: the
    // check ran live, so it compared 100 against an expectation of ~125 and
    // landed inside the tolerance. Against real (cached) data the true
    // numbers are 338 invoices to 505 customers - 67%, nowhere near 25% -
    // so the old expectation would fail immediately here.
    //
    // Invoices are generated by subscriptions rather than by a flat
    // percentage of customers, so the relationship that actually holds is
    // that every subscription produces at least one invoice. Measured:
    // 338 invoices to 222 subscriptions.
    assert(
      cached.invoices >= cached.subscriptions,
      `Expected at least one invoice per subscription, got ${cached.invoices} invoices ` +
        `for ${cached.subscriptions} subscriptions`
    );
  });

  await step("cached: the aggregate matches a total computed from the fetched rows", async () => {
    const r = await aggregateVsRaw(ctx, "charges", "amount");
    assertAggregateMatchesRaw(r, "cached charges");

    // The mirror of the live step: once cached, both the aggregate and the
    // fetch see the whole table, so the same equality now holds at the REAL
    // numbers instead of at the cap.
    assert(
      r.cnt > ctx.expectedCustomerCountNonCache,
      `Cached COUNT(*) on charges is ${r.cnt}, which is not above the live cap ` +
        `(${ctx.expectedCustomerCountNonCache}). Either the cache did not widen the scan, or this is ` +
        `reading live data - and then the comparison above proves nothing.`
    );
    console.log(
      `cached charges: COUNT(*)=${r.cnt}, SUM=${r.total}; ${r.rowCount} rows fetched summing to ${r.rowSum}`
    );
  });

  // THE ASSERTION THIS WHOLE TEST EXISTS TO MAKE, and until 2026-08-03 it had
  // never run. Every other check here is about how MANY rows come back; this is
  // the only one about whether caching preserves the VALUES.
  //
  // It looks up the SAME customer the live phase chose. That row was returned by
  // a live query, so a cached lookup missing it means caching lost a row - a
  // real defect, asserted rather than skipped.
  await step("cached field-level spot check matches the live one", async () => {
    // When the live phase was skipped there is no live target, so pick one from
    // the cached table instead. The value comparison then has nothing to compare
    // against, which the assertion below states explicitly rather than hiding.
    const targetName = liveSpotCheck ? liveSpotCheck.name : (await fetchFirstCustomer(ctx)).name;

    const cachedSpotCheck = await fetchCustomerByName(ctx, targetName);
    assert(
      cachedSpotCheck,
      `'${targetName}' was returned by a query before caching but cannot be found in the cached table. ` +
        `Caching appears to have lost a row - this is not a seed-data problem.`
    );
    assertEmailBelongsTo(cachedSpotCheck, `the cached customer '${targetName}'`);

    // The point of running this twice: caching must not alter field values,
    // only how many rows a count can see.
    if (!liveSpotCheck) {
      console.log(
        `note: the live phase was skipped, so '${targetName}' could only be checked in isolation - the ` +
          `live-vs-cached value comparison did not run this time`
      );
      return;
    }
    assert(
      cachedSpotCheck.email === liveSpotCheck.email && cachedSpotCheck.name === liveSpotCheck.name,
      `Cached row differs from the live row - live ${JSON.stringify(liveSpotCheck)}, ` +
        `cached ${JSON.stringify(cachedSpotCheck)}`
    );
    console.log(`live and cached rows for '${targetName}' match exactly`);
  });

  await step("live vs cached comparison summary", async () => {
    if (skipLivePhase) {
      note("skipped: no live measurements taken this run (tables were already cached)");
      return;
    }
    console.log("live vs cached counts (live values are subject to the ~100-row COUNT(*) cap):");
    for (const key of Object.keys(cached)) {
      const changed = live[key] === cached[key] ? "" : "   <-- differs";
      console.log(`  ${key.padEnd(18)} live=${String(live[key]).padEnd(8)} cached=${String(cached[key])}${changed}`);
    }
  });

  // ---------------------------------------------------------------- Phase 4

  await step("cache creation on a non-cacheable table fails cleanly", async () => {
    const res = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertStatus(res, 200, "listTables (finding a non-cacheable table)");
    const nonCacheable = res.body.find((t) => t.isCacheable === false);
    if (!nonCacheable) {
      note("skipped: every table in this Stripe catalog is cacheable, nothing to test here");
      return;
    }
    const createRes = await ctx.client.createCache({
      catalogId: ctx.catalogId,
      schemaName: ctx.schemaName,
      tableName: nonCacheable.tableName,
    });
    assertStatusIn(createRes, [400], "createCache on non-cacheable table");
    assert(
      createRes.body && createRes.body.errorCode === "TABLE_NOT_CACHEABLE",
      `Expected errorCode TABLE_NOT_CACHEABLE, got: ${JSON.stringify(createRes.body)}`
    );
  });

  // NOTE: duplicate-cache-creation behavior does not match Peaka's own docs.
  // Across five real observations on two tables (customers, promotion_codes):
  //   - 2026-07-21: 500 Internal Server Error, when the duplicate create was
  //     attempted while the original cache's initial sync was still RUNNING.
  //   - 2026-07-22 (x4): 200 OK, returning the existing cache's config
  //     unchanged, once the original cache had completed.
  // Peaka's docs specify 409 ("A cache already exists for this table"). Real
  // behavior is a silent get-or-create. After five consistent reproductions
  // this is treated as confirmed-if-undocumented, so [200, 409] both pass.
  // 500 is deliberately NOT accepted - that observation happened during a
  // genuine race (duplicate attempted mid-sync) and is a real server error.
  await step("duplicate cache creation is handled cleanly", async () => {
    const res = await ctx.client.createCache({
      catalogId: ctx.catalogId,
      schemaName: ctx.schemaName,
      tableName: "customers",
    });
    if (res.status === 200) {
      console.log(
        "note: got 200 (get-or-create) instead of the documented 409 for a duplicate cache on 'customers' - " +
          "confirmed, accepted real behavior, see the comment above"
      );
    }
    assertStatusIn(res, [200, 409], "duplicate createCache(customers)");
  });
}

module.exports = { runDataAndCache };
