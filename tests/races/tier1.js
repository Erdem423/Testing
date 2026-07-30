const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { duringSync, simultaneously, waitForSettled, readCacheStatus, sleep } = require("../../helpers/raceWindow");

// Chosen because it syncs SLOWLY (~37s), giving a wide window to fire into.
// This is the opposite of what m-cache-management.js wants - do not
// "optimise" this onto `transfers` (2.5s), which would silently destroy the
// overlap and make every result here meaningless. See CONCURRENCY-SPEC.md.
const SLOW_TABLE = "customers";

/**
 * Tier 1 concurrency conflicts - deliberately overlapping cache operations.
 *
 * WHY THESE ASSERT INVARIANTS RATHER THAN EXPECTED VALUES
 * Nothing documents what should happen when you delete a cache mid-sync. And
 * races may not fire at all. So a test that demands a specific outcome would
 * be red on a coin flip, which is worse than no test. Each step therefore
 * reports what actually happened and asserts only what must hold either way:
 * the resource settles rather than wedging, and it remains deletable.
 *
 * THE ONE DELIBERATE EXCEPTION is the duplicate-create step, which asserts
 * the CONFIRMED 500 - see its comment.
 *
 * Runs under `npm run test:races`, never `npm test`: these manufacture races
 * on purpose, and running them beside the main suite would create unintended
 * ones and produce failures that look like code regressions.
 */
async function runTier1Races(ctx) {
  // Everything below operates on THESE, never on PEAKA_CATALOG_ID.
  let raceCatalogId = null;
  let raceCatalogName = null;

  // WHY A THROWAWAY CATALOG, when Tier 1 previously used the shared one:
  // these steps repeatedly cache `customers`, which is also one of the four
  // tables `C` caches. Using the shared catalog meant an interrupted races run
  // left `customers` cached there - and `C` responds to a pre-existing cache by
  // silently skipping its entire live phase, including the 100-row cap
  // regression. That is not hypothetical: a dashboard server died mid-run and
  // left exactly that state behind.
  //
  // A catalog created on its own connection gets an INDEPENDENT copy of
  // `customers` - same 505 rows, same ~37s sync, so the race window is
  // unchanged - while being completely invisible to `C`. Tiers 2 and 3 already
  // work this way; this brings Tier 1 in line.
  await step("provision an isolated catalog for the races", async () => {
    const name = `e2e-auto-race1-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "stripe",
      credential: { token: ctx.stripeToken },
    });
    assertStatus(conn, 200, "createConnection (race catalog)");
    ctx.createdConnectionIds.push(conn.body.id);

    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, "createCatalog (race catalog)");
    raceCatalogId = cat.body.id;
    ctx.createdCatalogIds.push(raceCatalogId);

    const read = await ctx.client.getCatalog(raceCatalogId);
    assertStatus(read, 200, "getCatalog (race catalog)");
    raceCatalogName = read.body.name;
    assert(raceCatalogName, `Expected a queryable name on the race catalog: ${JSON.stringify(read.body)}`);
    assert(
      String(raceCatalogId) !== String(ctx.catalogId),
      "The race catalog must never be the shared PEAKA_CATALOG_ID"
    );
    console.log(`races will run against throwaway catalog ${raceCatalogName} (${raceCatalogId})`);
  });

  /** Fresh cache on the slow table, guaranteed to start from uncached. */
  async function freshCache() {
    // createCache is get-or-create, so this returns any existing cache, which
    // we then delete - a reliable "ensure uncached" with no list endpoint.
    const existing = await ctx.client.createCache({
      catalogId: raceCatalogId,
      schemaName: ctx.schemaName,
      tableName: SLOW_TABLE,
    });
    if (existing.status === 200 && existing.body && existing.body.id) {
      await waitForSettled(ctx, existing.body.id, { pollMs: 2000, maxAttempts: 20 });
      await ctx.client.deleteCache(existing.body.id);
      await sleep(2000);
    }
    const res = await ctx.client.createCache({
      catalogId: raceCatalogId,
      schemaName: ctx.schemaName,
      tableName: SLOW_TABLE,
    });
    assertStatus(res, 200, `createCache(${SLOW_TABLE})`);
    ctx.createdCacheIds.push(res.body.id);
    return res.body.id;
  }

  // ---------------------------------------------------------------- CANARY
  // Validates the harness against a race we already understand before
  // trusting it on unknowns: querying a table's ROWS while its cache syncs
  // returns 0 rows. This is the confirmed bug that forced the C/D merge.
  //
  // If this step stops detecting it, the harness is no longer entering the
  // window and every green result below is meaningless.
  //
  // THE TWO OUTCOMES ARE ASSERTED DIFFERENTLY, and the distinction is the
  // whole point:
  //
  //   never entered the RUNNING window  -> HARD FAIL. Window entry is a
  //       property of OUR harness, not of Peaka. If we cannot get inside the
  //       window, every "clean" result below means only "the code ran", and
  //       reporting the API as healthy on that basis would be worse than
  //       having no tests at all.
  //
  //   entered, but the count was not 0  -> log only. That is PEAKA'S
  //       behaviour, and a non-zero count most likely means the routing bug
  //       was fixed - good news, which must not turn the suite red.
  //
  // An earlier version logged both and could never fail, which defeated the
  // entire purpose of having a canary.
  await step("CANARY: querying rows mid-sync returns 0 (validates the harness)", async () => {
    const cacheId = await freshCache();
    const sql = `SELECT COUNT(*) AS cnt FROM "${raceCatalogName}"."${ctx.schemaName}"."${SLOW_TABLE}"`;
    const outcome = await duringSync(ctx, cacheId, () => ctx.client.executeQuery({ statement: sql }, "SIMPLE"));

    // Clean up before asserting, so a failure here doesn't strand the cache.
    const settledEarly = await waitForSettled(ctx, cacheId);
    await ctx.client.deleteCache(cacheId);
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);

    assert(
      outcome.enteredWindow,
      `CANARY FAILED: never observed the cache in RUNNING state (status at fire: ${outcome.statusAtFire}). ` +
        `The harness is not entering the sync window, so every other result in this file is meaningless - ` +
        `they would pass without any race actually occurring. Fix the timing before trusting anything below.`
    );

    const count = outcome.result.status === 200 ? Number(outcome.result.body.data[0].cnt) : null;
    console.log(`CANARY: entered window at ${outcome.msToRunning}ms; mid-sync count = ${count}`);
    if (count === 0) {
      console.log("CANARY OK: reproduced the known routing bug - the harness is entering the window.");
    } else {
      console.log(
        `CANARY: entered the window but got ${count} rather than 0. Peaka may have fixed the routing bug - ` +
          `verify by hand, and if so update the README and this step. Deliberately not failing: a fix is good news.`
      );
    }
    assert(settledEarly.settled, `Cache never settled after the canary race (last: ${settledEarly.status})`);
  });

  // ---------------------------------------------------------------- TIER 1.1
  // THE CONFIRMED BUG, and the only step here that asserts a specific status.
  //
  // Duplicate cache creation was recorded for months as "inconsistent" - 500
  // once, 200 four times - with the 500 dismissed as a one-off race. It is not
  // inconsistent, it is STATE-DEPENDENT:
  //     first sync still RUNNING  -> 500 Internal Server Error
  //     first sync COMPLETED      -> 200 (silent get-or-create)
  // Peaka's docs specify 409 for both. Reproduced first-try on 2026-07-30.
  // Every historical observation fits once cache state is accounted for.
  //
  // Asserting the 500 would institutionalise a server error as "correct", and
  // asserting [200, 409] would be permanently red. So this asserts the thing
  // that actually matters and would change if the bug got worse: the 500 is
  // NON-DESTRUCTIVE - the original sync still completes and the cache still
  // deletes. The status itself is reported, not asserted.
  await step("duplicate createCache mid-sync (known 500) is non-destructive", async () => {
    const cacheId = await freshCache();
    const outcome = await duringSync(ctx, cacheId, () =>
      ctx.client.createCache({ catalogId: raceCatalogId, schemaName: ctx.schemaName, tableName: SLOW_TABLE })
    );

    if (!outcome.enteredWindow) {
      console.log(`window missed (status at fire: ${outcome.statusAtFire}) - invariants still checked below`);
    } else if (outcome.result.status >= 500) {
      console.log(
        `reproduced the known 5xx: duplicate createCache during a RUNNING sync -> ${outcome.result.status}. ` +
          `Docs specify 409. Entered window at ${outcome.msToRunning}ms.`
      );
    } else {
      console.log(
        `duplicate createCache mid-sync returned ${outcome.result.status}, not the expected 500 - ` +
          `Peaka may have fixed this. Worth confirming by hand and updating README/HANDOFF.`
      );
    }

    // The invariants: whatever the duplicate returned, the original sync must
    // still finish and the cache must still be removable.
    const settled = await waitForSettled(ctx, cacheId);
    assert(
      settled.settled,
      `The original sync never settled after a duplicate create - the 500 would then be DESTRUCTIVE, ` +
        `which is materially worse than currently documented. Last status: ${settled.status}`
    );
    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the duplicate-create race");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });

  // ---------------------------------------------------------------- TIER 1.2
  // Entirely unexplored before this. Does deleting mid-sync block, error, or
  // orphan the running workflow?
  await step("deleteCache mid-sync does not orphan the cache", async () => {
    const cacheId = await freshCache();
    const outcome = await duringSync(ctx, cacheId, () => ctx.client.deleteCache(cacheId));

    console.log(
      `deleteCache mid-sync -> ${outcome.result.status} (entered window: ${outcome.enteredWindow}, ` +
        `status at fire: ${outcome.statusAtFire})`
    );
    assert(outcome.result.status < 500, `deleteCache mid-sync returned ${outcome.result.status} - a server error`);

    if (outcome.result.status === 200) {
      ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
      // If the delete succeeded, the table must actually report uncached -
      // otherwise the cache is orphaned: gone from our tracking but still
      // live server-side, and there is no endpoint that lists orphans.
      await sleep(3000);
      const isCached = await ctx.client.isTableCached(raceCatalogId, ctx.schemaName, SLOW_TABLE);
      assertStatus(isCached, 200, "isTableCached after mid-sync delete");
      console.log(`  after a mid-sync delete, isCached = ${isCached.body.isCached}`);
      assert(
        isCached.body.isCached === false,
        `deleteCache returned 200 mid-sync but the table still reports isCached:true - the cache is ORPHANED. ` +
          `No endpoint enumerates orphans (the schema-level status endpoint 500s), so this needs manual cleanup.`
      );
    } else {
      // Refused - legitimate. It must then still be deletable once settled.
      const settled = await waitForSettled(ctx, cacheId);
      assert(settled.settled, `Cache never settled after a refused mid-sync delete (last: ${settled.status})`);
      const del = await ctx.client.deleteCache(cacheId);
      assertStatus(del, 200, "deleteCache after the sync settled");
      ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
    }
  });

  // ---------------------------------------------------------------- TIER 1.3
  // Symmetric race - neither call is "the slow one", so both fire at once.
  await step("simultaneous incremental + full refresh do not corrupt the cache", async () => {
    const cacheId = await freshCache();
    const settledFirst = await waitForSettled(ctx, cacheId);
    assert(settledFirst.settled, `Initial sync never settled (last: ${settledFirst.status})`);

    const [incremental, full] = await simultaneously([
      () => ctx.client.triggerIncrementalUpdate(cacheId),
      () => ctx.client.triggerFullRefresh(cacheId),
    ]);

    for (const [label, o] of [["incremental", incremental], ["fullRefresh", full]]) {
      if (!o.ok) {
        console.log(`  ${label} threw: ${o.error && o.error.message}`);
        continue;
      }
      console.log(`  ${label} -> ${o.value.status}`);
      assert(o.value.status < 500, `${label} returned ${o.value.status} when raced - a server error`);
    }

    // The invariant that matters: two overlapping refreshes must not leave the
    // cache permanently mid-flight.
    const settled = await waitForSettled(ctx, cacheId, { pollMs: 3000, maxAttempts: 50 });
    assert(
      settled.settled,
      `Cache never settled after simultaneous incremental + full refresh (last: ${settled.status}) - ` +
        `overlapping refreshes appear to wedge it, which would be a real bug`
    );
    console.log(`  settled at ${settled.status} after the clash`);

    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the refresh clash");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });

  // Verifies the end state rather than assuming it. The previous version only
  // logged a warning here and then re-asserted that the HTTP call returned
  // 200 - which assertStatus above had already done - so the one thing this
  // step exists to check was the one thing it could not fail on.
  //
  // It now REMEDIES first and asserts second: a leftover cache is deleted, and
  // the step only fails if it cannot be cleared. That ordering matters because
  // failing outright would leave the mess in place for the next run, whereas
  // the goal is to end clean.
  await step("the slow table is left uncached", async () => {
    let res = await ctx.client.isTableCached(raceCatalogId, ctx.schemaName, SLOW_TABLE);
    assertStatus(res, 200, "isTableCached (final state)");

    if (res.body.isCached) {
      console.log(`${SLOW_TABLE} is still cached - a previous step's cleanup did not take effect; clearing it`);
      // createCache is get-or-create, so this hands back the existing cache.
      const existing = await ctx.client.createCache({
        catalogId: raceCatalogId,
        schemaName: ctx.schemaName,
        tableName: SLOW_TABLE,
      });
      if (existing.status === 200 && existing.body && existing.body.id) {
        // Can't delete mid-sync, so let it settle first.
        await waitForSettled(ctx, existing.body.id, { pollMs: 2000, maxAttempts: 30 });
        const del = await ctx.client.deleteCache(existing.body.id);
        console.log(`  deleteCache(${existing.body.id}) -> ${del.status}`);
        ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== existing.body.id);
      }
      await sleep(2000);
      res = await ctx.client.isTableCached(raceCatalogId, ctx.schemaName, SLOW_TABLE);
      assertStatus(res, 200, "isTableCached (after remediation)");
    }

    assert(
      res.body.isCached === false,
      `${SLOW_TABLE} is STILL cached after remediation. A leftover cache changes what later runs see - ` +
        `when this happened on the shared catalog it made C skip its entire live phase, silently dropping ` +
        `the 100-row cap regression. Needs manual cleanup in Peaka Studio.`
    );
  });
}

module.exports = { runTier1Races };
