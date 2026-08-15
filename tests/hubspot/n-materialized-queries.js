const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 45; // ~90s

// BOTH SPELLINGS ARE DELIBERATE - see tests/stripe/n-materialized-queries.js
// for the full explanation. This is a Peaka-wide API inconsistency
// (materialized query statuses use CANCELED, cache statuses use CANCELLED),
// not connector-specific, so it applies here unchanged.
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Materialized query endpoints, HubSpot version of
 * tests/stripe/n-materialized-queries.js. Content mirrors the Stripe version
 * (materialized queries are a generic Peaka concept, not connector-specific)
 * except for `type: "hubspot"` and querying `contacts` instead of `customers`.
 *
 * RUNS IN ITS OWN CATALOG, same reasoning as Stripe's version: this
 * materializes `contacts` purely as a fixture, not data under test, so it
 * must not touch the shared catalog C reads from a parallel worker.
 *
 * BLOCKED ON A REAL HUBSPOT CREDENTIAL - see tests/hubspot/h-catalogs.js's
 * header comment, including the note on why reusing the existing connection
 * (to avoid needing a token) was tried and rejected by Peaka with a 500.
 */
async function runMaterializedQueries(ctx) {
  let catalogName = null;
  let sql = null;
  let materializedId = null;
  let sourceQueryId = null;

  await step("provision an isolated catalog", async () => {
    const name = `e2e-auto-matq-cat-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "hubspot",
      credential: { accessToken: ctx.token },
    });
    assertStatus(conn, 200, "createConnection (materialized-query catalog)");
    ctx.createdConnectionIds.push(conn.body.id);

    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, "createCatalog (materialized-query catalog)");
    ctx.createdCatalogIds.push(cat.body.id);
    assert(
      String(cat.body.id) !== String(ctx.catalogId),
      "This scenario must never fall back to the shared PEAKA_HUBSPOT_CATALOG_ID"
    );

    const read = await ctx.client.getCatalog(cat.body.id);
    assertStatus(read, 200, "getCatalog (materialized-query catalog)");
    catalogName = read.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(read.body)}`);

    sql = `SELECT id FROM "${catalogName}"."${ctx.schemaName}"."contacts"`;
    console.log(`materialized queries will read from throwaway catalog ${catalogName} (${cat.body.id})`);
  });

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
    const last = await pollStatus("refresh", (s) => s === "COMPLETED" || s === "FAILED");
    assertEqual(String(last.status).toUpperCase(), "COMPLETED", "status after refresh");
    assert(
      last.lastExecutionStartTime,
      `Expected lastExecutionStartTime to be populated after a real refresh, got: ${JSON.stringify(last)}`
    );
  });

  // DETERMINISTIC BY CONSTRUCTION: settle first, THEN cancel - see the Stripe
  // version's extended comment for the full reasoning (a genuinely in-flight
  // cancel is a deliberate race and belongs in tests/hubspot-races, not here).
  await step("cancel with nothing running is handled cleanly", async () => {
    await pollStatus("settle before cancelling", (s) => TERMINAL.includes(s));

    const res = await ctx.client.cancelMaterializedQueryRefresh(materializedId);
    assertStatusIn(res, [200, 404], "cancelMaterializedQueryRefresh with nothing running");
    console.log(`cancel with nothing running -> ${res.status}`);
  });

  // KEYS ON THE EXECUTION TIMESTAMP, NOT THE STATUS - see the Stripe
  // version's comment: the status endpoint serves the previous terminal
  // status until a new run actually starts, so a status-only poll can be
  // satisfied by a stale value.
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
      res.body.inputQuery && res.body.inputQuery.includes("contacts"),
      `Expected the referenced query's SQL to be copied in, got: ${JSON.stringify(res.body.inputQuery)}`
    );
  });

  await step("delete the materialized query", async () => {
    const res = await ctx.client.deleteQuery(materializedId);
    assertStatus(res, 200, "deleteQuery(MATERIALIZED)");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== materializedId);

    const after = await ctx.client.getQuery(materializedId);
    assertStatusIn(after, [400, 404], "getQuery after deleting the materialized query");
  });
}

module.exports = { runMaterializedQueries };
