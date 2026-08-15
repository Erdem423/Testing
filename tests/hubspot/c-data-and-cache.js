const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");
const { pollCacheUntilComplete } = require("../../helpers/pollCacheUntilComplete");

/**
 * Data Correctness & Cache Behavior, HubSpot version of
 * tests/stripe/c-data-and-cache.js.
 *
 * IMPORTANT DIFFERENCE FROM THE STRIPE VERSION - READ BEFORE EXTENDING THIS.
 * The Stripe file asserts a confirmed, measured bug: live (uncached) queries
 * are capped at exactly 100 rows, matching Stripe's List API page size (see
 * FINDINGS.md #1). That is a MEASURED fact about Stripe's connector, not a
 * general Peaka behavior - HubSpot's API paginates differently, and this file
 * was written without HubSpot credentials available to measure anything
 * against the real API. So, deliberately, THIS FILE DOES NOT ASSERT A CAP.
 *
 * Instead it asserts connector-agnostic invariants that must hold regardless
 * of whether HubSpot turns out to have a similar cap:
 *   - live and cached counts are both non-negative numbers
 *   - cached count is never LESS than live count (caching must not lose data)
 *   - a >100-row LIMIT, live vs cached, is logged (not asserted) so a real
 *     run reveals whether a cap exists - if live gets stuck at a fixed number
 *     while cached exceeds it, that's the same signature as the Stripe bug
 *     and this file should then be tightened into a real regression test,
 *     the same way the Stripe one is.
 *
 * Once this has been run against real HubSpot data, come back and:
 *   1. decide whether a live-query cap exists here too (tighten the "capped"
 *      step from a log into a real assertion, one way or the other)
 *   2. replace the generic sanity checks below with real business-logic
 *      checks tailored to the seeded HubSpot data (e.g. a deal-stage
 *      distribution, mirroring Stripe's refund-rate/subscription-status
 *      checks) - column names needed for that are not confirmed yet either
 *
 * THE SHAPE (same as Stripe's, and for the same reason - see that file's
 * comment for why C and D were merged: caching a table while it's being
 * queried live can return 0 rows, so live-then-cache-then-cached in ONE test
 * removes the race rather than routing around it):
 *   Phase 1  every assertion while nothing is cached
 *   Phase 2  cache all data-correctness tables, wait for them to sync
 *   Phase 3  the same assertions again, now served from cache
 *   Phase 4  cache edge cases (non-cacheable table, duplicate creation)
 */

// The tables whose data these checks assert on, and therefore the tables
// this test caches. Confirmed to exist as plain (not "*_search" function-
// style) tables via Peaka Studio; sync timing not yet measured.
const DC_TABLES = ["contacts", "companies", "deals"];

function qname(ctx, tableName) {
  return `"${ctx.catalogName}"."${ctx.schemaName}"."${tableName}"`;
}

async function countRows(ctx, tableName) {
  const sql = `SELECT COUNT(*) AS cnt FROM ${qname(ctx, tableName)}`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, `count(${tableName})`);
  return Number(res.body.data[0].cnt);
}

async function measureCounts(ctx) {
  const counts = {};
  for (const tableName of DC_TABLES) {
    counts[tableName] = await countRows(ctx, tableName);
  }
  return counts;
}

/**
 * Fetches up to `limit` ids from a table. Mirrors the Stripe file's
 * row-retrieval cap check - see the module comment on why this one only
 * LOGS the result instead of asserting a specific cap.
 */
async function fetchIds(ctx, tableName, limit) {
  const sql = `SELECT id FROM ${qname(ctx, tableName)} LIMIT ${limit}`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, `SELECT id FROM ${tableName} LIMIT ${limit}`);
  return res.body.data.map((r) => r.id);
}

async function runDataAndCache(ctx) {
  let live = null;
  let cached = null;
  let liveRowSample = null;

  // Set if the tables are already cached when we start (leftover from
  // SKIP_CLEANUP=true, or a cleanup that failed) - see the Stripe version's
  // "self-heal" comment for the full reasoning behind clearing rather than
  // silently skipping.
  let skipLivePhase = false;

  // ---------------------------------------------------------------- Phase 1

  await step("resolve catalog name", async () => {
    await resolveCatalogName(ctx);
  });

  await step("data-correctness tables all start uncached", async () => {
    assert(ctx.catalogId, "Requires PEAKA_HUBSPOT_CATALOG_ID to be set in .env");
    assert(ctx.schemaName, "Requires PEAKA_HUBSPOT_SCHEMA_NAME to be set in .env");

    const check = async () => {
      const cachedTables = [];
      for (const tableName of DC_TABLES) {
        const res = await ctx.client.isTableCached(ctx.catalogId, ctx.schemaName, tableName);
        assertStatus(res, 200, `isCached(${tableName})`);
        if (res.body.isCached === true) cachedTables.push(tableName);
      }
      return cachedTables;
    };

    let alreadyCached = await check();

    // Same corruption detector as the Stripe version - a table reporting
    // isCached:true with no cache listed for the catalog is a contradiction
    // Peaka should never produce, regardless of connector. See FINDINGS.md
    // #2 ("Deleting a cache can permanently break a table") for the Stripe
    // occurrence this was written to catch.
    if (alreadyCached.length > 0) {
      const listed = await ctx.client.getAllCacheStatusesOfCatalog(ctx.catalogId);
      assertStatus(listed, 200, "getAllCacheStatusesOfCatalog");
      const listedTables = new Set((listed.body || []).map((entry) => entry.tableName));
      const phantom = alreadyCached.filter((t) => !listedTables.has(t));
      assert(
        phantom.length === 0,
        `CORRUPTED CACHE STATE: [${phantom.join(", ")}] report isCached:true but no cache is listed for ` +
          `this catalog. That combination is unrecoverable through the API - see FINDINGS.md's "Deleting a ` +
          `cache can permanently break a table" for the Stripe occurrence and the repair (rebuild the ` +
          `catalog in Peaka Studio, keeping the same name).`
      );
    }

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
          `phase cannot run. Delete those caches in Peaka Studio.`
      );
    }
  });

  await step("live counts are measured (no cap assumed for HubSpot)", async () => {
    if (skipLivePhase) {
      console.log("skipped: tables were already cached (see previous step)");
      return;
    }
    live = await measureCounts(ctx);
    for (const tableName of DC_TABLES) {
      assert(live[tableName] >= 0, `Expected a non-negative live count for ${tableName}, got ${live[tableName]}`);
    }
    console.log(
      "live counts (compare against the cached counts in Phase 3 - if these match exactly on every table " +
        "and the row-fetch check below also matches, HubSpot likely has no live-query cap; if live is stuck " +
        "at a round number while cached exceeds it, that's the same signature as Stripe's confirmed 100-row " +
        "cap, see FINDINGS.md #1):"
    );
    for (const [tableName, count] of Object.entries(live)) {
      console.log(`  ${tableName.padEnd(12)} live=${count}`);
    }
  });

  // Mirrors the Stripe file's row-retrieval cap check, but LOGS rather than
  // asserts a specific expected count - see the module comment.
  await step("a live SELECT with a large LIMIT is logged for cap detection", async () => {
    if (skipLivePhase) {
      console.log("skipped: tables were already cached");
      return;
    }
    const ids = await fetchIds(ctx, "contacts", 500);
    liveRowSample = ids.length;
    assert(
      new Set(ids).size === ids.length,
      `Expected no duplicate ids within a single page, got ${ids.length - new Set(ids).size} duplicates`
    );
    console.log(`live SELECT id FROM contacts LIMIT 500 returned ${ids.length} rows`);
  });

  await step("live field-level spot check", async () => {
    if (skipLivePhase) {
      console.log("skipped: tables were already cached");
      return;
    }
    if (live.contacts === 0) {
      console.log("skipped: no contacts found - is the HubSpot sandbox seeded?");
      return;
    }
    const sql = `SELECT id FROM ${qname(ctx, "contacts")} LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatus(res, 200, "spot check contact");
    assert(res.body.data.length > 0 && res.body.data[0].id, "Expected at least one contact row with an id");
  });

  // ---------------------------------------------------------------- Phase 2

  await step("create caches on all data-correctness tables", async () => {
    for (const tableName of DC_TABLES) {
      const res = await ctx.client.createCache({
        catalogId: ctx.catalogId,
        schemaName: ctx.schemaName,
        tableName,
      });
      assertStatusIn(res, [200, 409], `createCache(${tableName})`);
      assert(res.body && res.body.id, `Expected cache id in createCache(${tableName}) response`);
      ctx.createdCacheIds.push(res.body.id);
    }
  });

  await step("all caches reach a completed sync", async () => {
    // Polled together, not sequentially - see the Stripe file for why
    // (avoids paying the sum of sync times instead of just the slowest).
    // HubSpot's per-table sync duration is not yet measured, so this relies
    // on pollCacheUntilComplete's own timeout rather than a tuned one here.
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

  await step("cached counts are measured and compared against live", async () => {
    cached = await measureCounts(ctx);
    for (const tableName of DC_TABLES) {
      assert(cached[tableName] >= 0, `Expected a non-negative cached count for ${tableName}`);
      if (!skipLivePhase && live) {
        assert(
          cached[tableName] >= live[tableName],
          `Expected cached ${tableName} count (${cached[tableName]}) to be >= the live count ` +
            `(${live[tableName]}) - caching should never make a table's visible row count go DOWN.`
        );
        if (cached[tableName] > live[tableName]) {
          console.log(
            `NOTE: ${tableName} live=${live[tableName]} cached=${cached[tableName]} - live returned FEWER ` +
              `rows than cached. This is the same signature as Stripe's confirmed 100-row live-query cap ` +
              `(FINDINGS.md #1). Worth investigating and, if confirmed, turning into a real regression test.`
          );
        }
      }
    }
  });

  await step("a cached SELECT with a large LIMIT is logged for cap comparison", async () => {
    const ids = await fetchIds(ctx, "contacts", 500);
    assert(
      new Set(ids).size === ids.length,
      `Expected no duplicate ids across the cached page, got ${ids.length - new Set(ids).size} duplicates`
    );
    if (liveRowSample !== null) {
      console.log(`cached SELECT id FROM contacts LIMIT 500 returned ${ids.length} rows (live returned ${liveRowSample})`);
    } else {
      console.log(`cached SELECT id FROM contacts LIMIT 500 returned ${ids.length} rows (no live comparison this run)`);
    }
  });

  await step("live vs cached comparison summary", async () => {
    if (skipLivePhase || !live) {
      console.log("skipped: no live measurements taken this run (tables were already cached)");
      return;
    }
    console.log("live vs cached counts:");
    for (const key of Object.keys(cached)) {
      const changed = live[key] === cached[key] ? "" : "   <-- differs";
      console.log(`  ${key.padEnd(12)} live=${String(live[key]).padEnd(8)} cached=${String(cached[key])}${changed}`);
    }
  });

  // ---------------------------------------------------------------- Phase 4

  await step("cache creation on a non-cacheable table fails cleanly", async () => {
    const res = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertStatus(res, 200, "listTables (finding a non-cacheable table)");
    const nonCacheable = res.body.find((t) => t.isCacheable === false);
    if (!nonCacheable) {
      console.log("skipped: every table in this HubSpot catalog schema is cacheable, nothing to test here");
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

  // Same documented-vs-real divergence as Stripe's version may or may not
  // hold for HubSpot (docs specify 409, Stripe's real behavior is a silent
  // get-or-create 200, and a genuine mid-sync duplicate returns 500 - see
  // FINDINGS.md #3). Both 200 and 409 are accepted here without assuming
  // which one HubSpot actually returns; 500 is NOT accepted, since by the
  // time this step runs the "contacts" cache from Phase 2 has already
  // settled, so a 500 here would be a genuine new server error, not the
  // known mid-sync race.
  await step("duplicate cache creation is handled cleanly", async () => {
    const res = await ctx.client.createCache({
      catalogId: ctx.catalogId,
      schemaName: ctx.schemaName,
      tableName: "contacts",
    });
    if (res.status === 200) {
      console.log("note: got 200 (get-or-create) for a duplicate cache on 'contacts'");
    }
    assertStatusIn(res, [200, 409], "duplicate createCache(contacts)");
  });
}

module.exports = { runDataAndCache };
