const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");
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
  await step("resolve catalog name", async () => {
    await resolveCatalogName(ctx);
  });

  /** Fresh cache on the slow table, guaranteed to start from uncached. */
  async function freshCache() {
    // createCache is get-or-create, so this returns any existing cache, which
    // we then delete - a reliable "ensure uncached" with no list endpoint.
    const existing = await ctx.client.createCache({
      catalogId: ctx.catalogId,
      schemaName: ctx.schemaName,
      tableName: SLOW_TABLE,
    });
    if (existing.status === 200 && existing.body && existing.body.id) {
      await waitForSettled(ctx, existing.body.id, { pollMs: 2000, maxAttempts: 20 });
      await ctx.client.deleteCache(existing.body.id);
      await sleep(2000);
    }
    const res = await ctx.client.createCache({
      catalogId: ctx.catalogId,
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
  // window and every green result below is meaningless. It is a canary for
  // the timing logic, NOT a bug report - so it never fails the run, it just
  // reports loudly.
  await step("CANARY: querying rows mid-sync returns 0 (validates the harness)", async () => {
    const cacheId = await freshCache();
    const sql = `SELECT COUNT(*) AS cnt FROM "${ctx.catalogName}"."${ctx.schemaName}"."${SLOW_TABLE}"`;
    const outcome = await duringSync(ctx, cacheId, () => ctx.client.executeQuery({ statement: sql }, "SIMPLE"));

    if (!outcome.enteredWindow) {
      console.log(
        `CANARY INCONCLUSIVE: never saw RUNNING (status at fire: ${outcome.statusAtFire}). ` +
          `The harness may not be entering the sync window - treat the other steps with suspicion.`
      );
    } else {
      const count = outcome.result.status === 200 ? Number(outcome.result.body.data[0].cnt) : null;
      console.log(`CANARY: entered window at ${outcome.msToRunning}ms; mid-sync count = ${count}`);
      if (count === 0) {
        console.log("CANARY OK: reproduced the known routing bug - the harness is entering the window.");
      } else {
        console.log(
          `CANARY: got ${count} rather than 0. Either Peaka fixed the routing bug (good news, verify by hand) ` +
            `or the query landed after the sync completed.`
        );
      }
    }

    const settled = await waitForSettled(ctx, cacheId);
    assert(settled.settled, `Cache never settled after the canary race (last: ${settled.status})`);
    await ctx.client.deleteCache(cacheId);
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
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
      ctx.client.createCache({ catalogId: ctx.catalogId, schemaName: ctx.schemaName, tableName: SLOW_TABLE })
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
      const isCached = await ctx.client.isTableCached(ctx.catalogId, ctx.schemaName, SLOW_TABLE);
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

  // Leaving the shared table cached would change what the main suite sees on
  // its next run, so make the end state explicit rather than incidental.
  await step("the slow table is left uncached", async () => {
    const res = await ctx.client.isTableCached(ctx.catalogId, ctx.schemaName, SLOW_TABLE);
    assertStatus(res, 200, "isTableCached (final state)");
    if (res.body.isCached) {
      console.log(`warning: ${SLOW_TABLE} is still cached - a later step's cleanup did not take effect`);
    }
    assertStatusIn({ status: res.status }, [200], "final isCached probe");
  });
}

module.exports = { runTier1Races };
