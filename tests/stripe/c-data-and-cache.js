const { assertStatus, assertStatusIn, assert, assertApprox } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
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

/** Field-level spot check; returns the row so both passes can be compared. */
async function fetchSpotCheckCustomer(ctx) {
  const sql = `SELECT name, email FROM ${qname(ctx, "customers")} WHERE name = 'Test Customer 1' LIMIT 1`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, "spot check customer");
  return res.body.data.length > 0 ? res.body.data[0] : null;
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

    const alreadyCached = [];
    for (const tableName of DC_TABLES) {
      const res = await ctx.client.isTableCached(ctx.catalogId, ctx.schemaName, tableName);
      assertStatus(res, 200, `isCached(${tableName})`);
      if (res.body.isCached === true) alreadyCached.push(tableName);
    }

    if (alreadyCached.length > 0) {
      skipLivePhase = true;
      console.log(
        `note: [${alreadyCached.join(", ")}] already cached before this run - skipping the live/uncached ` +
          `phase, since a cached table can't measure the live COUNT(*) cap. Left over from SKIP_CLEANUP=true ` +
          `or a failed cleanup; delete those caches to get the full run back.`
      );
    }
  });

  await step("live counts are capped at 100 on every table", async () => {
    if (skipLivePhase) {
      console.log("skipped: tables were already cached (see previous step)");
      return;
    }
    live = await measureCounts(ctx);
    liveSpotCheck = await fetchSpotCheckCustomer(ctx);

    // Every one of these is expected to be exactly the cap, not the real
    // count - see the module comment. Tolerance stays tight (10%) because
    // the cap value itself is exact; it's the real counts that vary.
    for (const tableName of DC_TABLES) {
      assertApprox(live[tableName], ctx.expectedCustomerCountNonCache, 0.1, `live ${tableName} count (expected the cap)`);
    }
  });

  await step("live charge refund distribution is plausible", async () => {
    if (skipLivePhase) {
      console.log("skipped: tables were already cached");
      return;
    }
    if (live.charges === 0) {
      console.log("skipped: no charges found - did you run the seed script?");
      return;
    }
    // Seed targets ~15% refunded. Generous tolerance: this ratio is measured
    // over the capped first 100 rows here, so it's a sample, not the truth.
    assertApprox(live.chargesRefunded / live.charges, 0.15, 0.5, "live refunded charge percentage");
  });

  await step("live subscription status distribution is sane", async () => {
    if (skipLivePhase) {
      console.log("skipped: tables were already cached");
      return;
    }
    if (live.subscriptions === 0) {
      console.log("skipped: no subscriptions found - did you run the seed script?");
      return;
    }
    assert(live.subsActive + live.subsCanceled > 0, "Expected some active or canceled subscriptions");
    assert(
      live.subsActive + live.subsCanceled <= live.subscriptions,
      "active+canceled should not exceed total subscriptions"
    );
  });

  await step("live field-level spot check on a specific seeded customer", async () => {
    if (skipLivePhase) {
      console.log("skipped: tables were already cached");
      return;
    }
    if (!liveSpotCheck) {
      console.log("skipped: 'Test Customer 1' not found - seed script may use a different naming pattern");
      return;
    }
    assert(
      liveSpotCheck.email && liveSpotCheck.email.includes("test.customer1"),
      `Unexpected email for Test Customer 1: ${liveSpotCheck.email}`
    );
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

  await step("cached customer count matches the real seeded count", async () => {
    assertApprox(cached.customers, ctx.expectedCustomerCount, 0.1, "cached customer count");
  });

  await step("cached charge refund distribution is plausible", async () => {
    if (cached.charges === 0) {
      console.log("skipped: no charges found - did you run the seed script?");
      return;
    }
    // Same ~15% target as the live pass, but this one is measured over the
    // full table rather than a capped 100-row sample.
    assertApprox(cached.chargesRefunded / cached.charges, 0.15, 0.5, "cached refunded charge percentage");
  });

  await step("cached subscription status distribution is sane", async () => {
    if (cached.subscriptions === 0) {
      console.log("skipped: no subscriptions found - did you run the seed script?");
      return;
    }
    assert(cached.subsActive + cached.subsCanceled > 0, "Expected some active or canceled subscriptions");
    assert(
      cached.subsActive + cached.subsCanceled <= cached.subscriptions,
      "active+canceled should not exceed total subscriptions"
    );
  });

  await step("cached invoice count is consistent with subscriptions", async () => {
    if (cached.invoices === 0) {
      console.log("skipped: no invoices found - did you run the seed script?");
      return;
    }
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

  await step("cached field-level spot check matches the live one", async () => {
    const cachedSpotCheck = await fetchSpotCheckCustomer(ctx);
    if (!cachedSpotCheck) {
      console.log("skipped: 'Test Customer 1' not found - seed script may use a different naming pattern");
      return;
    }
    assert(
      cachedSpotCheck.email && cachedSpotCheck.email.includes("test.customer1"),
      `Unexpected cached email for Test Customer 1: ${cachedSpotCheck.email}`
    );
    // The point of running this twice: caching must not alter field values,
    // only how many rows a count can see.
    if (liveSpotCheck) {
      assert(
        cachedSpotCheck.email === liveSpotCheck.email && cachedSpotCheck.name === liveSpotCheck.name,
        `Cached row differs from the live row - live ${JSON.stringify(liveSpotCheck)}, ` +
          `cached ${JSON.stringify(cachedSpotCheck)}`
      );
    }
  });

  await step("live vs cached comparison summary", async () => {
    if (skipLivePhase) {
      console.log("skipped: no live measurements taken this run (tables were already cached)");
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
      console.log("skipped: every table in this Stripe catalog is cacheable, nothing to test here");
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
