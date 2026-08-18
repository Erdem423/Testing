const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { warnOnServerError, assertNoServerError } = require("../../helpers/serverError");
const {
  duringState,
  duringSync,
  simultaneously,
  waitForSettled,
  sleep,
  TERMINAL,
} = require("../../helpers/raceWindow");

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
      credential: { token: ctx.token },
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

    // The 5xx is RECORDED rather than logged, so it reaches the run banner,
    // coverage.json and the dashboard - see helpers/serverError.js. Still not
    // asserted, for the reason in the comment above: asserting it would
    // institutionalise a server error as correct.
    if (!outcome.enteredWindow) {
      console.log(`window missed (status at fire: ${outcome.statusAtFire}) - invariants still checked below`);
    } else if (
      !warnOnServerError(outcome.result, "duplicate createCache during a RUNNING sync", {
        reason:
          "KNOWN: docs specify 409; Peaka returns 5xx while the first sync is RUNNING " +
          "(reproduced 2026-07-30). Status is reported, never asserted - only non-destructiveness is.",
        context: `entered window at ${outcome.msToRunning}ms`,
      })
    ) {
      console.log(
        `duplicate createCache mid-sync returned ${outcome.result.status}, not the expected 500 - ` +
          `Peaka may have fixed this. Worth confirming by hand and updating FINDINGS.md.`
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
    assertNoServerError(outcome.result, "deleteCache mid-sync", {
      message: `deleteCache mid-sync returned ${outcome.result.status} - a server error`,
    });

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
      assertNoServerError(o.value, label, {
        message: `${label} returned ${o.value.status} when raced - a server error`,
      });
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

  // ---------------------------------------------------------------- TIER 1.4
  // CANCELLING SOMETHING GENUINELY IN FLIGHT.
  //
  // These three steps moved here out of the main suite (m-cache-management.js
  // and n-materialized-queries.js). Both files used to trigger an operation and
  // immediately cancel it, which is a race - the outcome depended on whether
  // the cancel or the operation won, so they hedged on [200, 404, 409] and
  // asserted almost nothing. Worse, the common outcome was that the operation
  // had ALREADY FINISHED, so the "cancel" tested the idle path by accident.
  //
  // Split by state instead: the main suite settles first and asserts the
  // nothing-is-running contract exactly, and the real race lives here, where
  // the harness enters the window on purpose and reports what it found.
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
    assertNoServerError(outcome.result, "cancelIncrementalUpdate", {
      message: `cancelIncrementalUpdate returned ${outcome.result.status} on a running update - a server error`,
    });

    // The invariant: a cancel must never leave the cache stuck mid-flight.
    const settled = await waitForSettled(ctx, cacheId);
    assert(
      settled.settled,
      `Cache never settled after cancelling a running incremental update (last: ${settled.status}) - ` +
        `a cancel that wedges a cache is a real bug`
    );
    console.log(`  settled at ${settled.status}`);

    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the incremental-cancel race");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });

  // ---------------------------------------------------------------- TIER 1.5
  // Same shape, but this one has a KNOWN server-side failure mode, which is why
  // it reads the full-refresh execution record specifically rather than using
  // duringSync.
  //
  // Cancelling before that record exists produces:
  //   500 NullPointerException - "Cannot invoke CacheExecutionInfo.getStatus()
  //   because getLastFullRefreshCacheExecution() is null"
  // Peaka dereferences the record without a null check, and the record is
  // created ASYNCHRONOUSLY after the trigger returns 200 (measured: trigger
  // returns in ~2.3s, record appears ~300ms later).
  //
  // duringSync would ALMOST do - helpers/cacheExecution.js now picks the most
  // recent execution record, so a full refresh is no longer shadowed by a stale
  // COMPLETED incremental (it was, and that bug is written up in the README).
  // This still reads the full-refresh slot directly for the other half of the
  // reason: waiting for that specific record guarantees it is non-null, which
  // is the NPE's precondition. So a 500 here means something genuinely new
  // rather than the already-documented crash.
  await step("cancelling a running full refresh settles cleanly", async () => {
    const cacheId = await freshCache();
    const first = await waitForSettled(ctx, cacheId);
    assert(first.settled, `Initial sync never settled (last: ${first.status})`);

    const readFullRefresh = async () => {
      const res = await ctx.client.getCacheStatus(cacheId);
      if (res.status !== 200) return `HTTP_${res.status}`;
      const exec = res.body.lastFullRefreshCacheExecution;
      return exec ? String(exec.status).toUpperCase() : "NO_RECORD";
    };
    const before = await readFullRefresh();

    const trigger = await ctx.client.triggerFullRefresh(cacheId);
    assertStatus(trigger, 200, "triggerFullRefresh");

    const outcome = await duringState(
      readFullRefresh,
      (s) => s === "RUNNING",
      () => ctx.client.cancelFullRefresh(cacheId),
      // Never give up on NO_RECORD - that is precisely the state being waited
      // out. Only a status that was already terminal BEFORE the trigger could
      // end the poll early, and that is indistinguishable from a stale value,
      // so let the timeout handle it instead.
      { pollMs: 250, maxWaitMs: 25000, isDone: () => false }
    );

    console.log(
      `cancelFullRefresh mid-flight -> ${outcome.result.status} ` +
        `(entered window: ${outcome.enteredWindow}, full-refresh status at fire: ${outcome.statusAtFire}, ` +
        `before trigger: ${before})`
    );
    if (!outcome.enteredWindow) {
      console.log("  window missed - the refresh record never reported RUNNING; invariants still checked below");
    }
    assertNoServerError(outcome.result, "cancelFullRefresh", {
      message: `cancelFullRefresh returned ${outcome.result.status} with the execution record ALREADY PRESENT ` +
    `(status at fire: ${outcome.statusAtFire}). The known NPE needs a null record, so this is a ` +
        `different failure: ${JSON.stringify(outcome.result.body).slice(0, 300)}`,
        });

    const settled = await waitForSettled(ctx, cacheId, { pollMs: 3000, maxAttempts: 50 });
    assert(
      settled.settled,
      `Cache never settled after cancelling a running full refresh (last: ${settled.status})`
    );
    console.log(`  settled at ${settled.status}`);

    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the full-refresh-cancel race");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });

  // ---------------------------------------------------------------- TIER 1.6
  // The materialized-query half of the same move, out of n-materialized-queries.js.
  //
  // NOTE THE SPELLING: materialized query statuses use CANCELED (one L) while
  // cache statuses use CANCELLED (two L's). This is a real inconsistency in
  // Peaka's API and it silently breaks any poll that handles only one - it cost
  // a debugging session once already. TERMINAL in helpers/raceWindow.js
  // deliberately contains both.
  await step("cancelling a running materialized refresh never wedges the query", async () => {
    const sql = `SELECT id, email FROM "${raceCatalogName}"."${ctx.schemaName}"."${SLOW_TABLE}"`;
    const created = await ctx.client.createQuery({
      displayName: `e2e-auto-race1-matq-${ctx.runTag}`,
      inputQuery: sql,
      queryType: "MATERIALIZED",
    });
    assertStatus(created, 200, "createQuery(MATERIALIZED) for the cancel race");
    const materializedId = created.body.id;
    ctx.createdQueryIds.push(materializedId);

    const readStatus = async () => {
      const res = await ctx.client.getMaterializedQueryStatus(materializedId);
      return res.status === 200 ? String(res.body.status).toUpperCase() : `HTTP_${res.status}`;
    };

    // Baseline for distinguishing a NEW execution from the stale status the
    // endpoint keeps serving until one starts - see below.
    const preTrigger = await ctx.client.getMaterializedQueryStatus(materializedId);
    assertStatus(preTrigger, 200, "getMaterializedQueryStatus (before the refresh)");
    const startBeforeTrigger = preTrigger.body.lastExecutionStartTime;

    const trigger = await ctx.client.refreshMaterializedQuery(materializedId);
    assertStatus(trigger, 200, "refreshMaterializedQuery");

    // FIRST VERSION OF THIS STEP NEVER ENTERED THE WINDOW - it reported
    // "status at fire: COMPLETED" every time, so it silently duplicated the
    // idle-cancel case the main suite already covers.
    //
    // Cause: the status endpoint keeps reporting the PREVIOUS terminal status
    // until the new run actually starts, so duringState's default isDone saw
    // COMPLETED on the very first poll and stopped before the refresh had
    // begun. Waiting for a specific status is not enough either - the stale
    // value may already BE that status.
    //
    // So the poll ignores any status until lastExecutionStartTime moves, and
    // never gives up on a terminal reading (isDone: false). Only a genuinely
    // new execution can end it.
    const readNewExecution = async () => {
      const res = await ctx.client.getMaterializedQueryStatus(materializedId);
      if (res.status !== 200) return `HTTP_${res.status}`;
      if (res.body.lastExecutionStartTime === startBeforeTrigger) return "STALE";
      return String(res.body.status).toUpperCase();
    };

    const outcome = await duringState(
      readNewExecution,
      (s) => s === "RUNNING",
      () => ctx.client.cancelMaterializedQueryRefresh(materializedId),
      { pollMs: 200, maxWaitMs: 30000, isDone: () => false }
    );
    console.log(
      `cancelMaterializedQueryRefresh mid-flight -> ${outcome.result.status} ` +
        `(entered window: ${outcome.enteredWindow}, status at fire: ${outcome.statusAtFire})`
    );
    assertNoServerError(outcome.result, "cancelMaterializedQueryRefresh", {
      message: `cancelMaterializedQueryRefresh returned ${outcome.result.status} - a server error`,
    });

    // THE INVARIANT THAT MATTERS. How fast it settles varies wildly - measured
    // COMPLETED immediately, CANCELED after ~20s, and once neither within 90s
    // on identical code - so settle time is reported, not asserted. What must
    // never happen is a cancel leaving a materialized query permanently broken.
    let settledStatus = null;
    for (let attempt = 1; attempt <= 40; attempt++) {
      const s = await readStatus();
      if (TERMINAL.includes(s)) {
        settledStatus = s;
        break;
      }
      await sleep(3000);
    }
    console.log(`  settled at ${settledStatus === null ? "still not terminal after ~120s" : settledStatus}`);

    // Recovery keys on the EXECUTION TIMESTAMP, not the status: the status
    // endpoint keeps reporting the previous terminal value until the new run
    // starts, so a status-based poll can be satisfied by a stale value the
    // instant it is called and pass without any refresh having happened.
    const before = await ctx.client.getMaterializedQueryStatus(materializedId);
    assertStatus(before, 200, "getMaterializedQueryStatus (before recovery)");
    const priorExecutionStart = before.body.lastExecutionStartTime;

    const recovery = await ctx.client.refreshMaterializedQuery(materializedId);
    assertStatus(recovery, 200, "refreshMaterializedQuery (recovery after cancel)");

    let recovered = null;
    for (let attempt = 1; attempt <= 45; attempt++) {
      const res = await ctx.client.getMaterializedQueryStatus(materializedId);
      assertStatus(res, 200, "getMaterializedQueryStatus (recovery)");
      const s = String(res.body.status).toUpperCase();
      if ((s === "COMPLETED" || s === "FAILED") && res.body.lastExecutionStartTime !== priorExecutionStart) {
        recovered = res.body;
        break;
      }
      await sleep(2000);
    }
    assert(
      recovered,
      `After cancelling a running refresh, a recovery refresh never produced a NEW completed execution ` +
        `within ~90s (lastExecutionStartTime stuck at ${priorExecutionStart}). The cancel appears to have ` +
        `left the materialized query wedged, which would be a serious bug.`
    );
    assert(
      String(recovered.status).toUpperCase() === "COMPLETED",
      `The recovery refresh ended at ${recovered.status}, not COMPLETED - cancelling seems to have ` +
        `damaged the query rather than just interrupting it`
    );
    console.log(`  recovery refresh ran: execution start moved ${priorExecutionStart} -> ${recovered.lastExecutionStartTime}`);

    const del = await ctx.client.deleteQuery(materializedId);
    assertStatus(del, 200, "deleteQuery after the materialized-cancel race");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== materializedId);
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
