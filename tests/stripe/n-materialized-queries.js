const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { provisionCatalogOnSharedConnection } = require("../../helpers/provisionCatalog");

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 45; // ~90s

// BOTH SPELLINGS ARE DELIBERATE - this is a real inconsistency in Peaka's API
// and it will silently break any polling loop that only handles one:
//   cache statuses            -> CANCELLED  (two L's, British)
//   materialized query status -> CANCELED   (one L, American)
// Confirmed 2026-07-29. The first version of this file only checked for
// CANCELLED, so a cancelled refresh polled until timeout and reported a
// "never settled" failure that looked exactly like the never-completing cache
// bug - but lastUpdateTime was moving the whole time. If you touch the cache
// poller (helpers/pollCacheUntilComplete.js), note it uses the OTHER spelling.
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Materialized query endpoints: create, read status, list statuses, refresh,
 * cancel.
 *
 * A materialized query is not a separate resource type - it's a saved query
 * created with queryType: "MATERIALIZED", so it's created and deleted through
 * the ordinary query endpoints and only its status/refresh live under
 * /materialized-queries.
 *
 * Two things settled by probing (2026-07-29) rather than taken from the docs:
 *   - inputQueryRefId is OPTIONAL. inputQuery alone materializes fine. When a
 *     ref id IS supplied, Peaka resolves it and copies that query's SQL in.
 *   - schedule is optional too; omitting it behaves like { type: "none" }.
 */
async function runMaterializedQueries(ctx) {
  // Resolved by the provisioning step below, never read from config - see the
  // comment on that step for why this scenario cannot use the shared catalog.
  let catalogName = null;
  let sql = null;
  let materializedId = null;
  let sourceQueryId = null;

  // RUNS IN ITS OWN CATALOG, for the same reason M does.
  //
  // This scenario materializes `customers` - one of the four tables C caches,
  // in the shared catalog, from a parallel Jest worker. Querying a table live
  // while a cache on it is syncing returns 0 rows, because Peaka's query
  // routing prefers an existing cache even before it has data. Materializing
  // across that window is what a 2026-07-31 run looked like: the initial
  // materialization sat at RUNNING past the 90s poll budget and the scenario
  // failed on its second step, with nothing wrong in this file.
  //
  // Nothing here needs the shared catalog - `customers` is a fixture for
  // exercising the materialized-query endpoints, not data under test. An
  // independent catalog on its own connection has identical contents and is
  // invisible to C.
  await step("provision an isolated catalog", async () => {
    const name = `e2e-auto-matq-cat-${ctx.runTag}`;
    // ON THE EXISTING CONNECTION - see helpers/provisionCatalog.js. The
    // isolation this scenario needs is at the CATALOG level (C caches
    // `customers` in the shared one, and querying a table live while a cache
    // on it syncs returns 0 rows); a separate connection was only ever the
    // means, and it cost a Stripe credential.
    const cat = { body: { id: (await provisionCatalogOnSharedConnection(ctx, name)).catalogId } };
    assert(
      String(cat.body.id) !== String(ctx.catalogId),
      "This scenario must never fall back to the shared PEAKA_CATALOG_ID"
    );

    const read = await ctx.client.getCatalog(cat.body.id);
    assertStatus(read, 200, "getCatalog (materialized-query catalog)");
    catalogName = read.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(read.body)}`);

    sql = `SELECT id, email FROM "${catalogName}"."${ctx.schemaName}"."customers"`;
    console.log(`materialized queries will read from throwaway catalog ${catalogName} (${cat.body.id})`);
  });

  /**
   * Polls until `accept(status)` is true.
   *
   * The `accept` parameter exists because of a real race: the status endpoint
   * keeps reporting the PREVIOUS terminal status until the newly triggered
   * run actually starts. Polling for "any terminal status" right after
   * triggering a refresh therefore returns the stale value immediately - it
   * caught this test out once, reporting CANCELED as the "result" of a
   * refresh that hadn't begun.
   *
   * Waiting for a specific STATUS only half-solves it, since the stale value
   * may already be the one you're waiting for. `accept` therefore receives the
   * whole body as its second argument, so callers that just triggered
   * something can require evidence of a NEW execution - see the recovery step,
   * which compares lastExecutionStartTime.
   */
  async function pollStatus(label, accept = (s) => TERMINAL.includes(s)) {
    let last = null;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const res = await ctx.client.getMaterializedQueryStatus(materializedId);
      assertStatus(res, 200, `getMaterializedQueryStatus (${label})`);
      last = res.body;
      if (accept(String(res.body.status).toUpperCase(), res.body)) return last;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `Materialized query never reached the expected state during '${label}' after ${MAX_POLL_ATTEMPTS} ` +
        `attempts (~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s). Last: ${JSON.stringify(last)}`
    );
  }

  await step("create a materialized query", async () => {
    const res = await ctx.client.createQuery({
      displayName: `e2e-auto-matq-${ctx.runTag}`,
      inputQuery: sql,
      queryType: "MATERIALIZED",
    });
    assertStatus(res, 200, "createQuery(MATERIALIZED)");
    assert(res.body && res.body.id, "Expected a query id");
    assertEqual(String(res.body.queryType).toUpperCase(), "MATERIALIZED", "queryType");
    materializedId = res.body.id;
    ctx.createdQueryIds.push(materializedId);
  });

  // WORTH KNOWING: a freshly created materialized query reports
  // status: COMPLETED with lastExecutionStartTime and lastUpdateTime BOTH
  // null. So COMPLETED here means "nothing is in flight", not "this has been
  // materialized" - don't read it as proof the data exists. The timestamps
  // only appear once an actual refresh has run, which is why the
  // lastExecutionStartTime assertion lives in the refresh step below rather
  // than here.
  await step("its status reaches a terminal state", async () => {
    const last = await pollStatus("initial materialization");
    assertEqual(String(last.status).toUpperCase(), "COMPLETED", "initial materialization status");
    assertEqual(String(last.queryId), String(materializedId), "status queryId");
    assert(last.scheduleSettings, `Expected scheduleSettings on the status, got: ${JSON.stringify(last)}`);
  });

  await step("the project-wide status list includes it", async () => {
    const res = await ctx.client.listMaterializedQueryStatuses();
    assertStatus(res, 200, "listMaterializedQueryStatuses");
    assert(Array.isArray(res.body), "Expected an array of materialized query statuses");
    assert(
      res.body.some((q) => String(q.queryId) === String(materializedId)),
      `Materialized query ${materializedId} not found in the project-wide status list`
    );
  });

  await step("trigger a refresh and wait for it to settle", async () => {
    const res = await ctx.client.refreshMaterializedQuery(materializedId);
    assertStatus(res, 200, "refreshMaterializedQuery");
    // Same stale-status race as the recovery step below: wait for COMPLETED
    // specifically, since the previous terminal status lingers until the new
    // run starts.
    const last = await pollStatus("refresh", (s) => s === "COMPLETED" || s === "FAILED");
    assertEqual(String(last.status).toUpperCase(), "COMPLETED", "status after refresh");
    // Only now should the execution timestamps be populated - see the note on
    // the previous step about a fresh query reporting COMPLETED with nulls.
    assert(
      last.lastExecutionStartTime,
      `Expected lastExecutionStartTime to be populated after a real refresh, got: ${JSON.stringify(last)}`
    );
  });

  // DETERMINISTIC BY CONSTRUCTION: settle first, THEN cancel.
  //
  // This used to trigger a refresh and immediately cancel it - a deliberate
  // race, and the main suite is the wrong place for one. The outcome depended
  // on who won: measured across runs the query settled at COMPLETED, at
  // CANCELED, and once not at all within 90s, on identical code. The step
  // accepted [200, 404, 409] and could not assert much as a result.
  //
  // Worse, the follow-up "recovery" check could be satisfied by a STALE
  // status: whenever the race landed on COMPLETED - the more common outcome -
  // a poll waiting for COMPLETED returned instantly without the recovery
  // refresh having run at all.
  //
  // Letting the refresh finish first makes "nothing is running" a guarantee,
  // so the endpoint's contract can be asserted exactly. Cancelling a refresh
  // that is genuinely in flight is a race, and now lives in
  // tests/races/tier1.js where the harness enters the window on purpose.
  await step("cancel with nothing running is handled cleanly", async () => {
    // Make sure the previous refresh is finished before cancelling.
    await pollStatus("settle before cancelling", (s) => TERMINAL.includes(s));

    const res = await ctx.client.cancelMaterializedQueryRefresh(materializedId);
    // Measured 200 in this state across repeated runs. Kept as a set rather
    // than a bare 200 because the endpoint is documented for an active
    // workflow and a not-found response would be equally defensible here -
    // what matters is that it does not error.
    assertStatusIn(res, [200, 404], "cancelMaterializedQueryRefresh with nothing running");
    console.log(`cancel with nothing running -> ${res.status}`);
  });

  // The invariant that matters regardless of how any cancel left things: a
  // materialized query must never be permanently wedged.
  //
  // KEYS ON THE EXECUTION TIMESTAMP, NOT THE STATUS. The status endpoint keeps
  // reporting the PREVIOUS terminal status until the newly triggered run
  // starts, so any status-based poll can be satisfied by a stale value the
  // instant it is called - which is exactly the bug described above.
  // lastExecutionStartTime changes only when a genuinely new execution begins.
  await step("a refresh always brings the query back to COMPLETED", async () => {
    const before = await ctx.client.getMaterializedQueryStatus(materializedId);
    assertStatus(before, 200, "getMaterializedQueryStatus (before recovery)");
    const priorExecutionStart = before.body.lastExecutionStartTime;

    const res = await ctx.client.refreshMaterializedQuery(materializedId);
    assertStatus(res, 200, "refreshMaterializedQuery (recovery)");

    const last = await pollStatus(
      "recovery refresh",
      (s, body) => (s === "COMPLETED" || s === "FAILED") && body.lastExecutionStartTime !== priorExecutionStart
    );
    assertEqual(String(last.status).toUpperCase(), "COMPLETED", "status after a recovery refresh");
    assert(
      last.lastExecutionStartTime !== priorExecutionStart,
      `The recovery refresh never produced a new execution - lastExecutionStartTime is still ` +
        `${priorExecutionStart}, so this step observed a stale status rather than a real refresh.`
    );
    console.log(`recovery refresh ran: execution start moved ${priorExecutionStart} -> ${last.lastExecutionStartTime}`);
  });

  // inputQueryRefId materializes an EXISTING saved query rather than inline
  // SQL. Verified by probing: Peaka resolves the reference and stores a fresh
  // snapshot of that query's SQL on the new materialized query.
  await step("a materialized query can reference an existing query", async () => {
    const source = await ctx.client.createQuery({
      displayName: `e2e-auto-matq-src-${ctx.runTag}`,
      inputQuery: sql,
      queryType: "PLAIN",
    });
    assertStatus(source, 200, "createQuery (source for materialization)");
    sourceQueryId = source.body.id;
    ctx.createdQueryIds.push(sourceQueryId);

    const res = await ctx.client.createQuery({
      displayName: `e2e-auto-matq-ref-${ctx.runTag}`,
      queryType: "MATERIALIZED",
      inputQueryRefId: sourceQueryId,
    });
    assertStatus(res, 200, "createQuery(MATERIALIZED via inputQueryRefId)");
    ctx.createdQueryIds.push(res.body.id);
    assertEqual(String(res.body.queryType).toUpperCase(), "MATERIALIZED", "queryType");
    assert(
      res.body.inputQuery && res.body.inputQuery.includes("customers"),
      `Expected the referenced query's SQL to be copied in, got: ${JSON.stringify(res.body.inputQuery)}`
    );
  });

  await step("delete the materialized query", async () => {
    const res = await ctx.client.deleteQuery(materializedId);
    assertStatus(res, 200, "deleteQuery(MATERIALIZED)");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== materializedId);

    const after = await ctx.client.getQuery(materializedId);
    // Peaka returns 400 rather than 404 for a missing query - see i-queries.js.
    assertStatusIn(after, [400, 404], "getQuery after deleting the materialized query");
  });
}

module.exports = { runMaterializedQueries };
