const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60;

// Same inconsistency PG-D documents - British CANCELLED for cache statuses,
// American CANCELED for materialized query status. Both accepted here too.
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * MO-D: Materialized query endpoints - the mirror of PG-D, itself the mirror
 * of Stripe's `N`.
 *
 * THE THIRD ROUTE TO THE MATERIALIZATION FINDING. Finding 2 records that a
 * materialized query over an uncached Stripe table freezes 100 of 505 rows
 * permanently. PG-D showed Postgres captures the whole table instead. Measured
 * live against MongoDB:
 *
 *   Stripe   `customers`   505 rows -> materialized result holds 100
 *   Postgres `e_commerce` 25000 rows -> materialized result holds 25000
 *   MongoDB  `commerce`   25000 rows -> materialized result holds 25000
 *
 * Together with MO-B (queries), MO-C (exports) and MO-H (saved queries) below,
 * that's the cap finding confirmed through every subsystem a THIRD time - the
 * boundary really does sit at the Stripe connector, not at "is this a
 * database" or "is this relational".
 *
 * NO ISOLATED CATALOG, same reasoning as PG-D: MongoDB has no caching at all
 * (see mo-a-discovery.js), so there is no sync window to collide with and the
 * shared catalog is safe.
 */
async function runMoMaterializedQueries(ctx) {
  let catalogName = null;
  let table = null;
  let sql = null;
  let materializedId = null;
  let materializedName = null;

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

  await step("resolve the catalog and discover a collection to materialize", async () => {
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
      displayName: `e2e-auto-mo-matq-${ctx.runTag}`,
      inputQuery: sql,
      queryType: "MATERIALIZED",
    });
    assertStatus(res, 200, "createQuery(MATERIALIZED)");
    assert(res.body && res.body.id, "Expected a query id");
    assertEqual(String(res.body.queryType).toUpperCase(), "MATERIALIZED", "queryType");
    materializedId = res.body.id;
    materializedName = res.body.name;
    assert(materializedName, `Expected a SQL-queryable name, got: ${JSON.stringify(res.body)}`);
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

  await step("the materialized result holds the WHOLE collection, not the live cap", async () => {
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
    // The assertEqual above is this step's real claim - the materialized
    // result holds the WHOLE collection - and it holds at any size. The
    // comparison against Stripe's cap below is a SECOND, weaker claim that
    // only means something when the collection is bigger than the cap; on a
    // smaller one, "1 row is not more than 100" says nothing about
    // truncation. Asserting it regardless failed this scenario on sample
    // data while its actual subject had already passed.
    if (materializedRows > ctx.expectedCustomerCountNonCache) {
      console.log(
        `materialized result holds ${materializedRows} of ${table.rowCount} rows - ` +
          `Stripe's equivalent freezes at ${ctx.expectedCustomerCountNonCache}`
      );
    } else {
      console.log(
        `materialized result holds all ${materializedRows} of ${table.rowCount} rows. Too few to also ` +
          `demonstrate it beats Stripe's ${ctx.expectedCustomerCountNonCache}-row cap - that half is skipped.`
      );
    }
  });

  await step("cancel with nothing running is handled cleanly", async () => {
    await pollStatus("settle before cancelling", (s) => TERMINAL.includes(s));
    const res = await ctx.client.cancelMaterializedQueryRefresh(materializedId);
    assertStatusIn(res, [200, 404], "cancelMaterializedQueryRefresh with nothing running");
    console.log(`cancel with nothing running -> ${res.status}`);
  });

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
    assertStatusIn(after, [400, 404], "getQuery after deleting the materialized query");
  });
}

module.exports = { runMoMaterializedQueries };
