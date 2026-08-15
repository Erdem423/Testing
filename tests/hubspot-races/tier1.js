const { assertStatus, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { duringSync, simultaneously, waitForSettled, sleep, TERMINAL } = require("../../helpers/raceWindow");

// UNVERIFIED PLACEHOLDER - unlike Stripe's SLOW_TABLE (measured ~37s sync on
// `customers`), no HubSpot table's sync duration has been measured yet.
// `contacts` is the largest known table by inspection in Peaka Studio, so
// it's the best guess for "syncs slowly enough to give a race a window to
// fire into" - but this is a guess, not a measurement. If the canary step
// below reports it never entered the RUNNING window, swap this for a
// genuinely slower table once one is identified.
const SLOW_TABLE = "contacts";

/**
 * Tier 1 concurrency conflicts, HubSpot version of tests/races/tier1.js.
 *
 * IMPORTANT DIFFERENCE FROM THE STRIPE VERSION - read before trusting any
 * "note:" log line below as a confirmed finding. Stripe's tier1 asserts (or
 * logs as "confirmed") several SPECIFIC, MEASURED Peaka bugs: querying rows
 * mid-sync returning exactly 0, duplicate createCache mid-sync returning
 * exactly 500, and a specific NullPointerException on cancelFullRefresh.
 * Those are facts about Stripe's connector, established by repeated
 * reproduction (see FINDINGS.md) - NOT general Peaka behavior. This file has
 * never been run against a real HubSpot connection, so every "note:" log
 * below reports what was OBSERVED this run rather than asserting it matches
 * Stripe's known bugs. Only the CANARY step's harness-validation check (did
 * we actually enter the RUNNING window?) is a hard assertion - that's a
 * property of this test's own timing, not of Peaka's behavior, so failing to
 * enter the window means the race is not being tested, regardless of
 * connector.
 *
 * WHY INVARIANTS, NOT EXPECTED VALUES - same reasoning as Stripe's version:
 * nothing documents what should happen when you delete a cache mid-sync, and
 * races may not fire at all. Each step asserts only what must hold either
 * way: the resource settles rather than wedging, and stays deletable.
 *
 * Runs under `npm run test:races`, never `npm test` - see jest.races.config.js.
 */
async function runTier1Races(ctx) {
  let raceCatalogId = null;
  let raceCatalogName = null;

  await step("provision an isolated catalog for the races", async () => {
    const name = `e2e-auto-race1-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "hubspot",
      credential: { accessToken: ctx.token },
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
      "The race catalog must never be the shared PEAKA_HUBSPOT_CATALOG_ID"
    );
    console.log(`races will run against throwaway catalog ${raceCatalogName} (${raceCatalogId})`);
  });

  async function freshCache() {
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
  // Validates the HARNESS (not Peaka) before trusting anything below: can we
  // reliably get inside a RUNNING sync window on this table? If not, every
  // other result in this file means only "the code ran", not "a race was
  // tested" - so THIS check is a hard assertion regardless of connector,
  // unlike the mid-sync row count itself (see the module comment).
  await step("CANARY: querying rows mid-sync (validates the harness enters the window)", async () => {
    const cacheId = await freshCache();
    const sql = `SELECT COUNT(*) AS cnt FROM "${raceCatalogName}"."${ctx.schemaName}"."${SLOW_TABLE}"`;
    const outcome = await duringSync(ctx, cacheId, () => ctx.client.executeQuery({ statement: sql }, "SIMPLE"));

    const settledEarly = await waitForSettled(ctx, cacheId);
    await ctx.client.deleteCache(cacheId);
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);

    assert(
      outcome.enteredWindow,
      `CANARY FAILED: never observed the cache in RUNNING state (status at fire: ${outcome.statusAtFire}). ` +
        `Either ${SLOW_TABLE} syncs too fast to race into, or the harness timing needs adjusting - every other ` +
        `result in this file would be meaningless without entering the window. If this table syncs fast, swap ` +
        `SLOW_TABLE for a genuinely slower one once measured.`
    );

    const count = outcome.result.status === 200 ? Number(outcome.result.body.data[0].cnt) : null;
    console.log(`CANARY: entered window at ${outcome.msToRunning}ms; mid-sync count = ${count}`);
    if (count === 0) {
      console.log(
        "note: mid-sync count was 0 - same signature as Stripe's confirmed query-routing bug (FINDINGS.md), " +
          "but this is the FIRST observation for HubSpot, not a confirmed finding. Worth reproducing before " +
          "treating as established."
      );
    } else {
      console.log(`note: mid-sync count was ${count} (non-zero) - no sign of the Stripe-style routing bug this run.`);
    }
    assert(settledEarly.settled, `Cache never settled after the canary race (last: ${settledEarly.status})`);
  });

  // ---------------------------------------------------------------- 1.1
  // UNLIKE the Stripe version, does NOT assume duplicate-create mid-sync
  // returns a specific status - that's a Stripe-specific confirmed finding.
  // This just observes and asserts the invariant that matters regardless of
  // status: the original sync must still finish and the cache must stay
  // deletable.
  await step("duplicate createCache mid-sync is non-destructive", async () => {
    const cacheId = await freshCache();
    const outcome = await duringSync(ctx, cacheId, () =>
      ctx.client.createCache({ catalogId: raceCatalogId, schemaName: ctx.schemaName, tableName: SLOW_TABLE })
    );

    if (!outcome.enteredWindow) {
      console.log(`window missed (status at fire: ${outcome.statusAtFire}) - invariants still checked below`);
    } else {
      console.log(
        `duplicate createCache during a RUNNING sync -> ${outcome.result.status} (entered window at ${outcome.msToRunning}ms)`
      );
    }

    const settled = await waitForSettled(ctx, cacheId);
    assert(
      settled.settled,
      `The original sync never settled after a duplicate create (last: ${settled.status})`
    );
    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the duplicate-create race");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });

  // ---------------------------------------------------------------- 1.2
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
      await sleep(3000);
      const isCached = await ctx.client.isTableCached(raceCatalogId, ctx.schemaName, SLOW_TABLE);
      assertStatus(isCached, 200, "isTableCached after mid-sync delete");
      console.log(`  after a mid-sync delete, isCached = ${isCached.body.isCached}`);
      assert(
        isCached.body.isCached === false,
        `deleteCache returned 200 mid-sync but the table still reports isCached:true - the cache is ORPHANED.`
      );
    } else {
      const settled = await waitForSettled(ctx, cacheId);
      assert(settled.settled, `Cache never settled after a refused mid-sync delete (last: ${settled.status})`);
      const del = await ctx.client.deleteCache(cacheId);
      assertStatus(del, 200, "deleteCache after the sync settled");
      ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
    }
  });

  // ---------------------------------------------------------------- 1.3
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

    const settled = await waitForSettled(ctx, cacheId, { pollMs: 3000, maxAttempts: 50 });
    assert(
      settled.settled,
      `Cache never settled after simultaneous incremental + full refresh (last: ${settled.status})`
    );
    console.log(`  settled at ${settled.status} after the clash`);

    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the refresh clash");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });

  // ---------------------------------------------------------------- 1.4
  await step("cancelling a running incremental update settles cleanly", async () => {
    const cacheId = await freshCache();
    const first = await waitForSettled(ctx, cacheId);
    assert(first.settled, `Initial sync never settled (last: ${first.status})`);

    const trigger = await ctx.client.triggerIncrementalUpdate(cacheId);
    assertStatus(trigger, 200, "triggerIncrementalUpdate");

    const outcome = await duringSync(ctx, cacheId, () => ctx.client.cancelIncrementalUpdate(cacheId));
    console.log(
      `cancelIncrementalUpdate mid-flight -> ${outcome.result.status} ` +
        `(entered window: ${outcome.enteredWindow}, status at fire: ${outcome.statusAtFire})`
    );
    if (!outcome.enteredWindow) {
      console.log("  window missed - the incremental finished first; invariants still checked below");
    }
    assert(
      outcome.result.status < 500,
      `cancelIncrementalUpdate returned ${outcome.result.status} on a running update - a server error`
    );

    const settled = await waitForSettled(ctx, cacheId);
    assert(
      settled.settled,
      `Cache never settled after cancelling a running incremental update (last: ${settled.status})`
    );
    console.log(`  settled at ${settled.status}`);

    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the incremental-cancel race");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });

  // ---------------------------------------------------------------- 1.5
  // UNLIKE the Stripe version, does NOT read the full-refresh execution
  // record specifically to dodge a known NullPointerException - that null
  // check gap is a confirmed Stripe-side finding (FINDINGS.md #4), not
  // assumed here. Uses the same generic duringSync helper as the other steps.
  await step("cancelling a running full refresh settles cleanly", async () => {
    const cacheId = await freshCache();
    const first = await waitForSettled(ctx, cacheId);
    assert(first.settled, `Initial sync never settled (last: ${first.status})`);

    const trigger = await ctx.client.triggerFullRefresh(cacheId);
    assertStatus(trigger, 200, "triggerFullRefresh");

    const outcome = await duringSync(ctx, cacheId, () => ctx.client.cancelFullRefresh(cacheId));
    console.log(
      `cancelFullRefresh mid-flight -> ${outcome.result.status} ` +
        `(entered window: ${outcome.enteredWindow}, status at fire: ${outcome.statusAtFire})`
    );
    if (outcome.result.status >= 500) {
      console.log(
        "  note: got a 5xx here - Stripe has a confirmed NullPointerException in this exact window " +
          "(FINDINGS.md #4). Worth checking whether HubSpot hits the same null-check gap."
      );
    }
    assert(outcome.result.status < 500, `cancelFullRefresh returned ${outcome.result.status} - a server error`);

    const settled = await waitForSettled(ctx, cacheId, { pollMs: 3000, maxAttempts: 50 });
    assert(settled.settled, `Cache never settled after cancelling a running full refresh (last: ${settled.status})`);
    console.log(`  settled at ${settled.status}`);

    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the full-refresh-cancel race");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });

  // Verifies the end state rather than assuming it - remedies first, asserts
  // second, same reasoning as the Stripe version.
  await step("the slow table is left uncached", async () => {
    let res = await ctx.client.isTableCached(raceCatalogId, ctx.schemaName, SLOW_TABLE);
    assertStatus(res, 200, "isTableCached (final state)");

    if (res.body.isCached) {
      console.log(`${SLOW_TABLE} is still cached - a previous step's cleanup did not take effect; clearing it`);
      const existing = await ctx.client.createCache({
        catalogId: raceCatalogId,
        schemaName: ctx.schemaName,
        tableName: SLOW_TABLE,
      });
      if (existing.status === 200 && existing.body && existing.body.id) {
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
      `${SLOW_TABLE} is STILL cached after remediation - needs manual cleanup in Peaka Studio.`
    );
  });
}

module.exports = { runTier1Races };
