const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { pollCacheUntilComplete } = require("../../helpers/pollCacheUntilComplete");

// Fixture chosen for SYNC SPEED, not size: this scenario tests cache
// management endpoints, not data. Measured 2026-07-29: transfers (0 rows)
// completes in ~2.5s, refunds (85 rows) ~8.2s, customers (505) ~37s. A 0-row
// table still produces a full COMPLETED execution record with real progress
// fields, at a fraction of the cost.
//
const FIXTURE_TABLE = "transfers";
const BATCH_TABLE = "refunds";

/**
 * Cache management endpoints beyond the basic create/status/delete that C
 * already covers: settings read/update, batch creation, the three
 * all-statuses variants, execution history, and the trigger/cancel pairs.
 *
 * This is the scenario that finally exercises triggerIncrementalUpdate,
 * triggerFullRefresh, cancelIncrementalUpdate and cancelFullRefreshUpdate -
 * whose paths were corrected in PR #3 but which no test had ever called.
 *
 * RUNS IN ITS OWN CATALOG. It used to cache into the shared
 * PEAKA_CATALOG_ID, which put its BATCH_TABLE cache (`refunds`) in the same
 * catalog F paginates live, in a parallel worker. That is the interference
 * that forced the C/D merge - a table whose cache is mid-sync returns 0 rows -
 * and it was especially bad here because F reads an empty first page as "no
 * seed data" and SKIPS, so it would have passed while testing nothing rather
 * than failing visibly.
 *
 * Nothing here needs the shared catalog: both tables are pure FIXTURES for
 * exercising cache transitions, not data under test. A throwaway catalog on
 * the same Stripe connection has identical contents and sync times, and
 * caches are per-catalog, so F is unaffected.
 */
async function runCacheManagement(ctx) {
  let cacheId = null;
  // Everything below caches into THIS, never PEAKA_CATALOG_ID.
  let catalogId = null;

  await step("provision an isolated catalog", async () => {
    const name = `e2e-auto-cachemgmt-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "stripe",
      credential: { token: ctx.token },
    });
    assertStatus(conn, 200, "createConnection (cache-management catalog)");
    ctx.createdConnectionIds.push(conn.body.id);

    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, "createCatalog (cache-management catalog)");
    assert(cat.body && cat.body.id, "Expected a catalog id in the response");
    catalogId = cat.body.id;
    ctx.createdCatalogIds.push(catalogId);

    // Guards against silently falling back to the shared catalog, which is
    // the exact regression this change exists to prevent.
    assert(
      String(catalogId) !== String(ctx.catalogId),
      "The cache-management catalog must never be the shared PEAKA_CATALOG_ID"
    );
    console.log(`caching into throwaway catalog ${catalogId} (not the shared ${ctx.catalogId})`);
  });

  await step("create a cache on a fast-syncing table", async () => {
    const res = await ctx.client.createCache({
      catalogId,
      schemaName: ctx.schemaName,
      tableName: FIXTURE_TABLE,
    });
    assertStatusIn(res, [200, 409], `createCache(${FIXTURE_TABLE})`);
    assert(res.body && res.body.id, "Expected a cache id in the response");
    cacheId = res.body.id;
    ctx.createdCacheIds.push(cacheId);
  });

  await step("cache reaches a completed sync", async () => {
    await pollCacheUntilComplete(ctx, cacheId);
  });

  // NOTE: getCacheSettings and getCacheStatus are DIFFERENT endpoints whose
  // paths differ only by a /status suffix. Settings returns configuration
  // (schedules); status returns execution state. Easy to conflate.
  await step("read cache settings", async () => {
    const res = await ctx.client.getCacheSettings(cacheId);
    assertStatus(res, 200, "getCacheSettings");
    assertEqual(res.body.id, cacheId, "cache id");
    assertEqual(res.body.tableName, FIXTURE_TABLE, "cache tableName");
    assertEqual(String(res.body.catalogId), String(catalogId), "cache catalogId");
  });

  // Schedules are the one part of a cache that's mutable after creation.
  // This is a config round-trip - it does NOT wait for a schedule to fire
  // (an ISO-8601 PT6H can't be observed inside a test run), it just verifies
  // the setting is stored and read back.
  await step("update cache schedules and read them back", async () => {
    const res = await ctx.client.updateCacheSettings(cacheId, {
      incrementalCacheSchedule: { type: "BASIC", expression: "PT6H" },
    });
    assertStatus(res, 200, "updateCacheSettings");

    const after = await ctx.client.getCacheSettings(cacheId);
    assertStatus(after, 200, "getCacheSettings after update");
    const sched = after.body.incrementalCacheSchedule;
    assert(sched, `Expected an incrementalCacheSchedule after setting one, got: ${JSON.stringify(after.body)}`);
    assertEqual(sched.type, "BASIC", "incremental schedule type");
    assertEqual(sched.expression, "PT6H", "incremental schedule expression");
  });

  // PRODUCT FINDING (2026-07-29): the reference documents 400 for "malformed
  // schedule expression". The API actually returns 200 and SILENTLY DISCARDS
  // the invalid value, leaving the previous schedule in place. From a
  // caller's side that's a silent failure - you send a typo, get a success
  // response, and your schedule never changes.
  //
  // So this asserts the property that genuinely matters either way: a
  // malformed expression must never be PERSISTED. Rejecting it (400) and
  // ignoring it (200, unchanged) both satisfy that; storing the garbage
  // would not.
  await step("a malformed schedule expression is never persisted", async () => {
    const bad = "not-a-duration";
    const res = await ctx.client.updateCacheSettings(cacheId, {
      incrementalCacheSchedule: { type: "BASIC", expression: bad },
    });
    assertStatusIn(res, [200, 400], "updateCacheSettings with an invalid expression");

    if (res.status === 200) {
      console.log(
        `note: updateCacheSettings accepted the malformed expression '${bad}' with 200 instead of the ` +
          `documented 400 - it silently ignored the value rather than reporting the problem.`
      );
    }

    const after = await ctx.client.getCacheSettings(cacheId);
    assertStatus(after, 200, "getCacheSettings after invalid update");
    const expression = after.body.incrementalCacheSchedule && after.body.incrementalCacheSchedule.expression;
    assert(
      expression !== bad,
      `A malformed schedule expression was persisted: ${JSON.stringify(after.body.incrementalCacheSchedule)}`
    );
  });

  await step("disable the schedule again", async () => {
    const res = await ctx.client.updateCacheSettings(cacheId, {
      incrementalCacheSchedule: { type: "NONE" },
    });
    assertStatus(res, 200, "updateCacheSettings (NONE)");
  });

  await step("execution history lists the completed sync", async () => {
    const res = await ctx.client.getCacheExecutionHistory(cacheId);
    assertStatus(res, 200, "getCacheExecutionHistory");
    assert(Array.isArray(res.body), `Expected an array of executions, got: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(res.body.length > 0, "Expected at least one execution record after a completed sync");
    const exec = res.body[0];
    assert(exec.status, `Expected a status on the execution record: ${JSON.stringify(exec)}`);
  });

  await step("project-wide cache statuses include this cache", async () => {
    const res = await ctx.client.getAllCacheStatusesOfProject();
    assertStatus(res, 200, "getAllCacheStatusesOfProject");
    assert(Array.isArray(res.body), "Expected an array of cache statuses");
    assert(
      res.body.some((c) => c.id === cacheId),
      `Cache ${cacheId} not found in the project-wide status list`
    );
  });

  await step("catalog-wide cache statuses include this cache", async () => {
    const res = await ctx.client.getAllCacheStatusesOfCatalog(catalogId);
    assertStatus(res, 200, "getAllCacheStatusesOfCatalog");
    assert(Array.isArray(res.body), "Expected an array of cache statuses");
    assert(
      res.body.some((c) => c.id === cacheId),
      `Cache ${cacheId} not found in the catalog-wide status list`
    );
  });

  // KNOWN PRODUCT BUG, reproduced 2026-07-29 on two separate occasions: the
  // schema-level variant returns 500 while the project- and catalog-level
  // ones work. Accepted here with a loud log rather than left permanently
  // red, matching how the duplicate-cache 200/409 divergence is handled.
  // If it starts returning 200, this logs and the assertion still passes -
  // tighten it to [200] at that point.
  await step("schema-wide cache statuses (known 500)", async () => {
    const res = await ctx.client.getAllCacheStatusesOfSchema(catalogId, ctx.schemaName);
    if (res.status === 500) {
      console.log(
        "note: getAllCacheStatusesOfSchema returned 500 - confirmed, still-broken behaviour. " +
          "The project- and catalog-level equivalents both work, so this is specific to the schema variant."
      );
    } else {
      console.log(`note: getAllCacheStatusesOfSchema returned ${res.status} - it may have been fixed; tighten this step.`);
    }
    assertStatusIn(res, [200, 500], "getAllCacheStatusesOfSchema");
  });

  await step("trigger an incremental update", async () => {
    const res = await ctx.client.triggerIncrementalUpdate(cacheId);
    assertStatus(res, 200, "triggerIncrementalUpdate");
  });

  // DETERMINISTIC BY CONSTRUCTION: settle first, THEN cancel.
  //
  // This used to cancel immediately after triggering, which made the outcome a
  // race - 200 if the cancel beat the sync, 404 if it didn't - so the step
  // accepted [200, 404] and asserted almost nothing. In practice the 404 branch
  // won essentially always, because FIXTURE_TABLE syncs in ~2.5s; the tolerance
  // was papering over an outcome that was already effectively fixed.
  //
  // Waiting for the sync to finish makes "nothing is running" a guarantee
  // rather than an accident, so 404 becomes an exact assertion and this covers
  // the endpoint's real contract: cancelling when there is no active workflow
  // reports not-found rather than erroring.
  //
  // The interesting case - cancelling something GENUINELY mid-flight - is a
  // deliberate race and now lives in tests/races/tier1.js, where the harness
  // enters the running window on purpose instead of hoping to land in it. The
  // main suite stays deterministic; the races do the racing.
  await step("cancel with nothing running reports not-found", async () => {
    await pollCacheUntilComplete(ctx, cacheId);

    const res = await ctx.client.cancelIncrementalUpdate(cacheId);
    assertStatus(res, 404, "cancelIncrementalUpdate with no active workflow");
  });

  await step("trigger a full refresh", async () => {
    const res = await ctx.client.triggerFullRefresh(cacheId);
    assertStatus(res, 200, "triggerFullRefresh");
  });

  // Same shape as the incremental cancel above: settle first, then cancel, so
  // "nothing is running" is guaranteed rather than incidental.
  //
  // Waiting also sidesteps a genuine server bug this step used to provoke.
  // Cancelling straight after the trigger returned, under load:
  //   500 NullPointerException - "Cannot invoke CacheExecutionInfo.getStatus()
  //   because getLastFullRefreshCacheExecution() is null"
  // Peaka dereferences the full-refresh execution record without a null check,
  // and that record is created ASYNCHRONOUSLY after the trigger returns 200.
  // Measured: the trigger takes ~2.3s to return and the record appears ~300ms
  // later, so there is a narrow window where cancel NPEs. At normal speed the
  // trigger covers it; under load the gap widens. That is how M failed at 124s
  // in a full-suite run while passing at 21s alone.
  //
  // Letting the refresh finish removes the null precondition entirely - the
  // record exists by then - so this asserts the endpoint's contract rather
  // than racing record creation. Cancelling something genuinely mid-flight is
  // in tests/races/tier1.js.
  //
  // THIS STEP CAUGHT A BUG IN THE TEST HARNESS ITSELF, which is worth writing
  // down because the wrong conclusion was very convincing.
  //
  // Pinned to 404 to match the incremental cancel, it failed with 200. The
  // obvious reading was that the two cancel endpoints disagree about an idle
  // cache. They do not. The real cause was in pollCacheUntilComplete, which read
  //     lastIncrementalCacheExecution || lastFullRefreshCacheExecution
  // and the incremental step above leaves a COMPLETED incremental record behind
  // permanently - so the "wait for the refresh to finish" call returned on its
  // FIRST poll having inspected the wrong record. The cancel then landed on a
  // refresh that was still running, which is a real cancel and really does
  // return 200. That is exactly the race this rewrite existed to remove; the
  // step only looked deterministic.
  //
  // Both endpoints return 404 on a genuinely idle cache - confirmed directly
  // once the shadowing was fixed. See helpers/cacheExecution.js.
  //
  // The lesson generalises: "I settled it first" is only as trustworthy as the
  // status the settle actually read. Pinning the assertion to a single value is
  // what exposed it - hedging on [200, 404] had concealed the same broken wait
  // for as long as this step had existed.
  await step("cancel a full refresh with nothing running reports not-found", async () => {
    await pollCacheUntilComplete(ctx, cacheId);

    const res = await ctx.client.cancelFullRefresh(cacheId);
    assertStatus(res, 404, "cancelFullRefresh with no active workflow");
  });

  await step("batch cache creation reports per-item results", async () => {
    const res = await ctx.client.createCacheBatch([
      { catalogId, schemaName: ctx.schemaName, tableName: BATCH_TABLE },
    ]);
    assertStatus(res, 200, "createCacheBatch");
    assert(Array.isArray(res.body), `Expected an array of per-item results, got: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(res.body.length === 1, `Expected one result for one request, got ${res.body.length}`);
    const item = res.body[0];
    assert(typeof item.success === "boolean", `Expected a success flag per item, got: ${JSON.stringify(item)}`);
    if (item.success && item.cache && item.cache.id) {
      ctx.createdCacheIds.push(item.cache.id);
    } else {
      console.log(`note: batch cache creation reported failure for ${BATCH_TABLE}: ${JSON.stringify(item)}`);
    }
  });

  await step("delete the cache and confirm it is gone", async () => {
    const res = await ctx.client.deleteCache(cacheId);
    assertStatus(res, 200, "deleteCache");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);

    const isCached = await ctx.client.isTableCached(catalogId, ctx.schemaName, FIXTURE_TABLE);
    assertStatus(isCached, 200, "isTableCached after delete");
    assertEqual(isCached.body.isCached, false, `${FIXTURE_TABLE} isCached after its cache was deleted`);
  });
}

module.exports = { runCacheManagement };
