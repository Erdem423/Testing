const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable, withRetry } = require("./fixture");

/**
 * GA-H: Saved-query endpoints - the mirror of MO-H/PG-H, itself the mirror
 * of Stripe's `I`.
 *
 * A FIFTH ROUTE TO THE CAP FINDING, after MO-B/GA-B-equivalent(queries),
 * exports (GA-C), and materialization (GA-D): a saved query over
 * `ad_group_criterion` returns all 2,860 rows, not a 100-row cap.
 *
 * RETRIED on creation and on the headline execute step - see fixture.js and
 * finding 35.
 */
async function runGaQueries(ctx) {
  const displayName = `e2e_auto_ga_query_${ctx.runTag}`.replace(/-/g, "_");
  const originalSql = "SELECT 1 AS one";
  let catalogName = null;
  let table = null;
  let queryId = null;

  await step("resolve the catalog and discover a table", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    table = await resolveLargeTable(ctx, catalogName);
  });

  await step("create a saved query", async () => {
    const result = await withRetry(async () => {
      const res = await ctx.client.createQuery({ displayName, inputQuery: originalSql, queryType: "PLAIN" });
      return { empty: res.status !== 200, value: res };
    }, "createQuery");
    assertStatus(result.value, 200, "createQuery");
    assert(result.value.body && result.value.body.id, "Expected a query id in the response");
    assertEqual(result.value.body.displayName, displayName, "query displayName");
    queryId = result.value.body.id;
    ctx.createdQueryIds.push(queryId);
  });

  await step("list queries includes the new one", async () => {
    const res = await ctx.client.listQueries();
    assertStatus(res, 200, "listQueries");
    assert(res.body.some((q) => q.id === queryId), `Newly created query ${queryId} not found in listQueries`);
  });

  await step("read the query back", async () => {
    const res = await ctx.client.getQuery(queryId);
    assertStatus(res, 200, "getQuery");
    assertEqual(res.body.id, queryId, "query id");
    assertEqual(res.body.inputQuery, originalSql, "query inputQuery");
    assertEqual(res.body.queryType, "PLAIN", "queryType");
  });

  await step("update the query to read a real Google Ads table", async () => {
    const updatedSql = `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}"`;
    const res = await ctx.client.updateQuery(queryId, { inputQuery: updatedSql });
    assertStatus(res, 200, "updateQuery");
    const after = await ctx.client.getQuery(queryId);
    assertStatus(after, 200, "getQuery after update");
    assertEqual(after.body.inputQuery, updatedSql, "inputQuery after update");
    assertEqual(after.body.displayName, displayName, "displayName survives an inputQuery-only update");
  });

  await step("running the saved query returns the whole table, not the live cap", async () => {
    const read = await ctx.client.getQuery(queryId);
    assertStatus(read, 200, "getQuery (for its SQL name)");
    const sqlName = read.body.name;
    assert(sqlName, `Expected a SQL-queryable name on the query: ${JSON.stringify(read.body).slice(0, 200)}`);

    const result = await withRetry(async () => {
      const res = await ctx.client.executeQuery(
        { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."query"."${sqlName}"` },
        "SIMPLE"
      );
      assertStatus(res, 200, "COUNT(*) over the saved query");
      const empty = !res.body.data || res.body.data.length === 0;
      return { empty, value: empty ? null : Number(res.body.data[0].cnt) };
    }, "saved query row count");

    assertEqual(result.value, table.rowCount, `rows visible through the saved query over '${table.tableName}'`);
    // Same split as ga-d-materialized-queries.js: the assertEqual above is the
    // real claim and holds at any size.
    if (result.value > ctx.expectedCustomerCountNonCache) {
      console.log(`saved query sees ${result.value} rows - Stripe's equivalent would see ${ctx.expectedCustomerCountNonCache}`);
    } else {
      console.log(
        `saved query sees all ${result.value} rows. Too few to also demonstrate it beats Stripe's ` +
          `${ctx.expectedCustomerCountNonCache}-row cap - that half is skipped.`
      );
    }
  });

  await step("transpile SQL to another dialect", async () => {
    const res = await ctx.client.transpileSql("postgres", 'SELECT * FROM "a"."b"."c" WHERE id = 1');
    assertStatus(res, 200, "transpileSql(postgres)");
    const transpiled = res.body.query || res.body.result;
    assert(typeof transpiled === "string" && transpiled.length > 0, `Expected transpiled SQL, got: ${JSON.stringify(res.body)}`);
  });

  await step("delete the query and confirm it is gone", async () => {
    const res = await ctx.client.deleteQuery(queryId);
    assertStatus(res, 200, "deleteQuery");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== queryId);
    const after = await ctx.client.getQuery(queryId);
    assertStatusIn(after, [400, 404], "getQuery after delete");
  });
}

module.exports = { runGaQueries };
