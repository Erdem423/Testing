const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { pollCacheUntilComplete } = require("../../helpers/pollCacheUntilComplete");

// MEASURED (2026-08-12) against the real crm schema, same discipline as
// Stripe's FIXTURE_TABLE/BATCH_TABLE choice (see tests/stripe/m-cache-management.js):
// createCache + poll to COMPLETED, timed directly, in a throwaway catalog.
//   deals_pipeline_stages  COMPLETED  ~4.5s   (FULL_REFRESH only)
//   deals                  COMPLETED  ~4.4s   (FULL_REFRESH + INCREMENTAL)
//   tasks                  COMPLETED  ~5.1s   (FULL_REFRESH + INCREMENTAL)
//   owners, pipelines, products, feedback_submissions
//                          never reached COMPLETED - still RUNNING after 60s.
// This is the SAME failure mode FINDINGS.md #5 documents for Stripe (a cache
// job enqueued and never picked up, indistinguishable from healthy while it's
// running) - now confirmed on HubSpot too, on multiple tables. The original
// placeholder choice here (`line_items` / `feedback_submissions`) was one of
// the ones that hangs; a real run against real data caught it (see the
// M: Cache Management Endpoints failure that prompted this measurement).
//
// FIXTURE_TABLE needs INCREMENTAL support (this scenario triggers both an
// incremental update and a full refresh), so `tasks` - not the marginally
// faster `deals_pipeline_stages`, which only supports FULL_REFRESH.
const FIXTURE_TABLE = "tasks";
const BATCH_TABLE = "deals_pipeline_stages";

/**
 * Cache management endpoints beyond basic create/status/delete, HubSpot
 * version of tests/stripe/m-cache-management.js. Content mirrors the Stripe
 * version (this endpoint group is generic Peaka cache-management behavior,
 * not connector-specific) except for `type: "hubspot"` and the fixture
 * tables above.
 *
 * RUNS IN ITS OWN CATALOG, same reasoning as Stripe's version: this caches
 * fixture tables purely to exercise cache-lifecycle endpoints, not as data
 * under test, so there's no reason to risk colliding with C's cached tables
 * in the shared catalog.
 *
 * BLOCKED ON A REAL HUBSPOT CREDENTIAL - see tests/hubspot/h-catalogs.js's
 * header comment, including the note on why reusing the existing connection
 * (to avoid needing a token) was tried and rejected by Peaka with a 500.
 */
async function runCacheManagement(ctx) {
  let cacheId = null;
  let catalogId = null;

  await step("provision an isolated catalog", async () => {
    const name = `e2e-auto-cachemgmt-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "hubspot",
      credential: { accessToken: ctx.token },
    });
    assertStatus(conn, 200, "createConnection (cache-management catalog)");
    ctx.createdConnectionIds.push(conn.body.id);

    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, "createCatalog (cache-management catalog)");
    assert(cat.body && cat.body.id, "Expected a catalog id in the response");
    catalogId = cat.body.id;
    ctx.createdCatalogIds.push(catalogId);

    assert(
      String(catalogId) !== String(ctx.catalogId),
      "The cache-management catalog must never be the shared PEAKA_HUBSPOT_CATALOG_ID"
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

  await step("read cache settings", async () => {
    const res = await ctx.client.getCacheSettings(cacheId);
    assertStatus(res, 200, "getCacheSettings");
    assertEqual(res.body.id, cacheId, "cache id");
    assertEqual(res.body.tableName, FIXTURE_TABLE, "cache tableName");
    assertEqual(String(res.body.catalogId), String(catalogId), "cache catalogId");
  });

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

  // Same invariant as Stripe's version (see that file's comment for the full
  // reasoning): don't assume 400 vs 200-and-ignored, just assert a malformed
  // expression is never PERSISTED.
  await step("a malformed schedule expression is never persisted", async () => {
    const bad = "not-a-duration";
    const res = await ctx.client.updateCacheSettings(cacheId, {
      incrementalCacheSchedule: { type: "BASIC", expression: bad },
    });
    assertStatusIn(res, [200, 400], "updateCacheSettings with an invalid expression");

    if (res.status === 200) {
      console.log(
        `note: updateCacheSettings accepted the malformed expression '${bad}' with 200 - check whether it ` +
          `silently ignored it, same as the confirmed Stripe behavior (FINDINGS.md's "smaller quirks").`
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

  // UNLIKE the Stripe version, this does NOT assume the schema-level variant
  // returns 500 - that was confirmed specifically for a stripe catalog. Logs
  // whichever status comes back so this can be tightened once observed.
  await step("schema-wide cache statuses (status not yet confirmed for hubspot)", async () => {
    const res = await ctx.client.getAllCacheStatusesOfSchema(catalogId, ctx.schemaName);
    console.log(`note: getAllCacheStatusesOfSchema returned ${res.status} for a hubspot catalog`);
    assertStatusIn(res, [200, 500], "getAllCacheStatusesOfSchema");
  });

  await step("trigger an incremental update", async () => {
    const res = await ctx.client.triggerIncrementalUpdate(cacheId);
    assertStatus(res, 200, "triggerIncrementalUpdate");
  });

  // DETERMINISTIC BY CONSTRUCTION: settle first, THEN cancel - see the Stripe
  // version's extended comment for why (a race here is deliberately covered
  // instead by tests/hubspot-races once that lands, not the main suite).
  await step("cancel with nothing running reports not-found", async () => {
    await pollCacheUntilComplete(ctx, cacheId);

    const res = await ctx.client.cancelIncrementalUpdate(cacheId);
    assertStatus(res, 404, "cancelIncrementalUpdate with no active workflow");
  });

  await step("trigger a full refresh", async () => {
    const res = await ctx.client.triggerFullRefresh(cacheId);
    assertStatus(res, 200, "triggerFullRefresh");
  });

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
