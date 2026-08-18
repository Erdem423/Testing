const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");
const { resolveLargeTable, withRetry } = require("./fixture");

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 40;
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GA-D: Materialized query endpoints - the mirror of MO-D/PG-D, itself the
 * mirror of Stripe's `N`.
 *
 * A FIFTH ROUTE TO THE MATERIALIZATION-CAP FINDING (finding 2), after
 * Stripe (freezes 100 of 505), Postgres and MongoDB (both capture the whole
 * table). Google Ads agrees: materializing `ad_group_criterion` (2,860 rows)
 * captures all 2,860.
 *
 * RETRIED where it matters - see finding 35. The initial creation and the
 * headline row-count step both go through fixture.js's withRetry; the
 * recovery-refresh step already keys on lastExecutionStartTime MOVING rather
 * than on a status value, which happens to make it naturally retry-tolerant
 * on its own (a stale/empty read there just means "keep polling").
 */
async function runGaMaterializedQueries(ctx) {
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
    throw new Error(`Materialized query never reached the expected state during '${label}'. Last: ${JSON.stringify(last)}`);
  }

  await step("resolve the catalog and discover a table to materialize", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    table = await resolveLargeTable(ctx, catalogName);
    sql = `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}"`;
    console.log(`materializing '${table.tableName}' (${table.rowCount} rows)`);
  });

  await step("create a materialized query", async () => {
    const res = await withRetry(async () => {
      const r = await ctx.client.createQuery({
        displayName: `e2e-auto-ga-matq-${ctx.runTag}`,
        inputQuery: sql,
        queryType: "MATERIALIZED",
      });
      return { empty: r.status !== 200, value: r };
    }, "createQuery(MATERIALIZED)");
    assertStatus(res.value, 200, "createQuery(MATERIALIZED)");
    assert(res.value.body && res.value.body.id, "Expected a query id");
    materializedId = res.value.body.id;
    materializedName = res.value.body.name;
    assert(materializedName, `Expected a SQL-queryable name, got: ${JSON.stringify(res.value.body)}`);
    ctx.createdQueryIds.push(materializedId);
  });

  await step("its status reaches a terminal state", async () => {
    const last = await pollStatus("initial materialization");
    assertEqual(String(last.status).toUpperCase(), "COMPLETED", "initial materialization status");
    assertEqual(String(last.queryId), String(materializedId), "status queryId");
  });

  await step("the project-wide status list includes it", async () => {
    const res = await ctx.client.listMaterializedQueryStatuses();
    assertStatus(res, 200, "listMaterializedQueryStatuses");
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
    assert(last.lastExecutionStartTime, `Expected lastExecutionStartTime after a real refresh, got: ${JSON.stringify(last)}`);
  });

  await step("the materialized result holds the WHOLE table, not the live cap", async () => {
    const result = await withRetry(async () => {
      const res = await ctx.client.executeQuery(
        { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."query"."${materializedName}"` },
        "SIMPLE"
      );
      assertStatus(res, 200, "COUNT(*) over the materialized result");
      const empty = !res.body.data || res.body.data.length === 0;
      return { empty, value: empty ? null : Number(res.body.data[0].cnt) };
    }, "materialized row count");

    assertEqual(result.value, table.rowCount, `rows captured by the materialized query over '${table.tableName}'`);
    // The assertEqual above is the real claim and holds at any size. Beating
    // Stripe's cap is a second, weaker claim that only means something on a
    // table bigger than the cap - see tests/postgres/pg-d-materialized-queries.js.
    if (result.value > ctx.expectedCustomerCountNonCache) {
      console.log(`materialized result holds ${result.value} of ${table.rowCount} rows - Stripe's equivalent freezes at ${ctx.expectedCustomerCountNonCache}`);
    } else {
      note(
        `materialized result holds all ${result.value} of ${table.rowCount} rows. Too few to also demonstrate ` +
          `it beats Stripe's ${ctx.expectedCustomerCountNonCache}-row cap - that half is skipped.`
      );
    }
  });

  await step("cancel with nothing running is handled cleanly", async () => {
    await pollStatus("settle before cancelling", (s) => TERMINAL.includes(s));
    const res = await ctx.client.cancelMaterializedQueryRefresh(materializedId);
    assertStatusIn(res, [200, 404], "cancelMaterializedQueryRefresh with nothing running");
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
    assert(last.lastExecutionStartTime !== priorExecutionStart, `The recovery refresh never produced a new execution.`);
  });

  await step("delete the materialized query", async () => {
    const res = await ctx.client.deleteQuery(materializedId);
    assertStatus(res, 200, "deleteQuery(MATERIALIZED)");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== materializedId);
    const after = await ctx.client.getQuery(materializedId);
    assertStatusIn(after, [400, 404], "getQuery after deleting the materialized query");
  });
}

module.exports = { runGaMaterializedQueries };
