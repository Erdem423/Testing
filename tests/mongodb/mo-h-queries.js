const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

/**
 * MO-H: Saved-query endpoints - the mirror of PG-H, itself the mirror of
 * Stripe's `I`.
 *
 * SAME CRUD, PLUS THE FOURTH ROUTE TO THE CAP FINDING for MongoDB (after
 * MO-B/queries, MO-C/exports, MO-D/materialization):
 *
 *   Stripe:   a saved query over `customers` returns at most ~100 rows
 *   Postgres: the same shape returns the whole table
 *   MongoDB:  the same shape returns the whole collection
 *
 * The project holds unrelated pre-existing queries, so every assertion looks
 * for OUR query by id rather than asserting on list length.
 */
async function runMoQueries(ctx) {
  const displayName = `e2e_auto_mo_query_${ctx.runTag}`.replace(/-/g, "_");
  const originalSql = "SELECT 1 AS one";
  let catalogName = null;
  let table = null;
  let queryId = null;

  await step("resolve the catalog and discover a collection", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    table = await resolveLargeTable(ctx, catalogName);
  });

  await step("create a saved query", async () => {
    const res = await ctx.client.createQuery({ displayName, inputQuery: originalSql, queryType: "PLAIN" });
    assertStatus(res, 200, "createQuery");
    assert(res.body && res.body.id, "Expected a query id in the response");
    assertEqual(res.body.displayName, displayName, "query displayName");
    queryId = res.body.id;
    ctx.createdQueryIds.push(queryId);
  });

  await step("list queries includes the new one", async () => {
    const res = await ctx.client.listQueries();
    assertStatus(res, 200, "listQueries");
    assert(Array.isArray(res.body), "Expected an array of queries");
    assert(
      res.body.some((q) => q.id === queryId),
      `Newly created query ${queryId} not found in listQueries (${res.body.length} returned)`
    );
  });

  await step("read the query back", async () => {
    const res = await ctx.client.getQuery(queryId);
    assertStatus(res, 200, "getQuery");
    assertEqual(res.body.id, queryId, "query id");
    assertEqual(res.body.inputQuery, originalSql, "query inputQuery");
    assertEqual(res.body.queryType, "PLAIN", "queryType");
  });

  await step("update the query to read a real MongoDB collection", async () => {
    const updatedSql = `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}"`;
    const res = await ctx.client.updateQuery(queryId, { inputQuery: updatedSql });
    assertStatus(res, 200, "updateQuery");

    const after = await ctx.client.getQuery(queryId);
    assertStatus(after, 200, "getQuery after update");
    assertEqual(after.body.inputQuery, updatedSql, "inputQuery after update");
    assertEqual(after.body.displayName, displayName, "displayName survives an inputQuery-only update");
  });

  await step("running the saved query returns the whole collection, not the live cap", async () => {
    const read = await ctx.client.getQuery(queryId);
    assertStatus(read, 200, "getQuery (for its SQL name)");
    const sqlName = read.body.name;
    assert(sqlName, `Expected a SQL-queryable name on the query: ${JSON.stringify(read.body).slice(0, 200)}`);

    const res = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."query"."${sqlName}"` },
      "SIMPLE"
    );
    assertStatus(res, 200, "COUNT(*) over the saved query");
    const rows = Number(res.body.data[0].cnt);

    assertEqual(rows, table.rowCount, `rows visible through the saved query over '${table.tableName}'`);
    // Same split as mo-d-materialized-queries.js: the assertEqual above is
    // the real claim (the saved query sees the whole collection) and holds at
    // any size. Beating Stripe's cap is a second claim that needs a
    // collection bigger than the cap to mean anything.
    if (rows > ctx.expectedCustomerCountNonCache) {
      console.log(`saved query sees ${rows} rows - Stripe's equivalent would see ${ctx.expectedCustomerCountNonCache}`);
    } else {
      console.log(
        `saved query sees all ${rows} rows. Too few to also demonstrate it beats Stripe's ` +
          `${ctx.expectedCustomerCountNonCache}-row cap - that half is skipped.`
      );
    }
  });

  await step("transpile SQL to another dialect", async () => {
    const res = await ctx.client.transpileSql("postgres", 'SELECT * FROM "a"."b"."c" WHERE id = 1');
    assertStatus(res, 200, "transpileSql(postgres)");
    const transpiled = res.body.query || res.body.result;
    assert(
      typeof transpiled === "string" && transpiled.length > 0,
      `Expected transpiled SQL, got: ${JSON.stringify(res.body)}`
    );
  });

  await step("delete the query and confirm it is gone", async () => {
    const res = await ctx.client.deleteQuery(queryId);
    assertStatus(res, 200, "deleteQuery");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== queryId);

    const after = await ctx.client.getQuery(queryId);
    assertStatusIn(after, [400, 404], "getQuery after delete");
  });
}

module.exports = { runMoQueries };
