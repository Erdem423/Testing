const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60; // ~120s - materializing a real table takes longer than Stripe's capped 100 rows

// BOTH SPELLINGS ARE DELIBERATE - a real inconsistency in Peaka's API that will
// silently break any polling loop handling only one:
//   cache statuses            -> CANCELLED  (two L's, British)
//   materialized query status -> CANCELED   (one L, American)
// See tests/stripe/n-materialized-queries.js, where this cost a debugging session.
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * PG-D: Materialized query endpoints - the mirror of Stripe's `N`.
 *
 * THE ROW COUNT IS THE POINT, as in PG-C. FINDINGS.md records that a
 * materialized query over an uncached Stripe table PERMANENTLY captures 100 of
 * 505 rows - the live cap frozen into stored results that then look
 * authoritative forever. Measured against Postgres 2026-08-07:
 *
 *   Stripe   `customers`   505 rows -> materialized result holds 100
 *   Postgres `e_commerce` 25000 rows -> materialized result holds 25000
 *
 * Together with PG-B (queries) and PG-C (exports) that is the third
 * independent route to the same conclusion: the cap is a property of the
 * STRIPE CONNECTOR's API pagination, not of Peaka's query, export, or
 * materialization machinery. Three different subsystems, one connector-shaped
 * boundary.
 *
 * NO ISOLATED CATALOG HERE, unlike `N`. That scenario provisions a throwaway
 * connection and catalog because it materializes `customers` while `C` is
 * caching the same table in a parallel worker, and querying a table live while
 * a cache on it syncs returns 0 rows. Postgres has no caching at all (see
 * pg-a-discovery.js), so there is no such window and the shared catalog is
 * safe - which is also why this file needs no database credentials.
 */
async function runPgMaterializedQueries(ctx) {
  let catalogName = null;
  let table = null;
  let sql = null;
  let materializedId = null;
  let materializedName = null;

  /**
   * Polls until `accept(status, body)` is true.
   *
   * `accept` takes the whole body because the status endpoint keeps reporting
   * the PREVIOUS terminal status until a newly triggered run actually starts -
   * so polling for "any terminal status" right after a refresh returns the
   * stale value instantly. Callers that just triggered something require
   * evidence of a NEW execution instead; see the recovery step.
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

  await step("resolve the catalog and discover a table to materialize", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(res.body)}`);
    table = await resolveLargeTable(ctx, catalogName);
    sql = `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}"`;
    console.log(`materializing '${table.tableName}' (${table.rowCount} rows)`);
  });

  await step("create a materialized query", async () => {
    const res = await ctx.client.createQuery({
      displayName: `e2e-auto-pg-matq-${ctx.runTag}`,
      inputQuery: sql,
      queryType: "MATERIALIZED",
    });
    assertStatus(res, 200, "createQuery(MATERIALIZED)");
    assert(res.body && res.body.id, "Expected a query id");
    assertEqual(String(res.body.queryType).toUpperCase(), "MATERIALIZED", "queryType");
    materializedId = res.body.id;
    // The SQL-queryable form, distinct from displayName - this is how the
    // stored result is read back below.
    materializedName = res.body.name;
    assert(materializedName, `Expected a SQL-queryable name, got: ${JSON.stringify(res.body)}`);
    ctx.createdQueryIds.push(materializedId);
  });

  // WORTH KNOWING: a freshly created materialized query reports COMPLETED with
  // lastExecutionStartTime null - so COMPLETED here means "nothing in flight",
  // NOT "this has been materialized". Confirmed identical on Postgres. The
  // timestamp assertion therefore lives in the refresh step, not here.
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

    // REQUIRES A REAL EXECUTION, not just a terminal status. A freshly created
    // materialized query already reports COMPLETED with lastExecutionStartTime
    // null (see the previous step), so polling for "COMPLETED" alone returns
    // that STALE value instantly and the assertion below then fails on a
    // refresh that had not started yet. Keying on the timestamp appearing is
    // the same technique the recovery step uses, and for the same reason.
    const last = await pollStatus(
      "refresh",
      (s, body) => (s === "COMPLETED" || s === "FAILED") && !!body.lastExecutionStartTime
    );
    assertEqual(String(last.status).toUpperCase(), "COMPLETED", "status after refresh");
    assert(
      last.lastExecutionStartTime,
      `Expected lastExecutionStartTime to be populated after a real refresh, got: ${JSON.stringify(last)}`
    );
  });

  // THE HEADLINE. `N` cannot make this assertion at all - against Stripe the
  // materialized result holds 100 of 505 rows, permanently. Here the stored
  // result must match the source table exactly.
  await step("the materialized result holds the WHOLE table, not the live cap", async () => {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."query"."${materializedName}"` },
      "SIMPLE"
    );
    assertStatus(res, 200, "COUNT(*) over the materialized result");
    const materializedRows = Number(res.body.data[0].cnt);

    assertEqual(
      materializedRows,
      table.rowCount,
      `rows captured by the materialized query over '${table.tableName}'`
    );
    // The assertEqual above is this step's real claim - the materialized result
    // holds the WHOLE table - and it holds at any size. Beating Stripe's cap is
    // a second, weaker claim that only means something on a table bigger than
    // the cap: "1 row is not more than 100" says nothing about truncation.
    if (materializedRows > ctx.expectedCustomerCountNonCache) {
      console.log(
        `materialized result holds ${materializedRows} of ${table.rowCount} rows - ` +
          `Stripe's equivalent freezes at ${ctx.expectedCustomerCountNonCache}`
      );
    } else {
      note(
        `materialized result holds all ${materializedRows} of ${table.rowCount} rows. Too few to also ` +
          `demonstrate it beats Stripe's ${ctx.expectedCustomerCountNonCache}-row cap - that half is skipped.`
      );
    }
  });

  await step("cancel with nothing running is handled cleanly", async () => {
    await pollStatus("settle before cancelling", (s) => TERMINAL.includes(s));
    const res = await ctx.client.cancelMaterializedQueryRefresh(materializedId);
    // A set rather than a bare 200: the endpoint is documented for an active
    // workflow, so a not-found response would be equally defensible here. What
    // matters is that it does not error.
    assertStatusIn(res, [200, 404], "cancelMaterializedQueryRefresh with nothing running");
    console.log(`cancel with nothing running -> ${res.status}`);
  });

  // The invariant that matters regardless of how a cancel left things: a
  // materialized query must never be permanently wedged.
  //
  // KEYS ON THE EXECUTION TIMESTAMP, NOT THE STATUS - the status endpoint
  // serves the previous terminal value until a new run begins, so any
  // status-based poll can be satisfied by a stale reading the instant it is
  // called. lastExecutionStartTime only moves for a genuinely new execution.
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

  await step("delete the materialized query", async () => {
    const res = await ctx.client.deleteQuery(materializedId);
    assertStatus(res, 200, "deleteQuery(MATERIALIZED)");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== materializedId);

    const after = await ctx.client.getQuery(materializedId);
    // Peaka returns 400 rather than 404 for a missing query - see i-queries.js.
    assertStatusIn(after, [400, 404], "getQuery after deleting the materialized query");
  });
}

module.exports = { runPgMaterializedQueries };
