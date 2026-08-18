const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

/**
 * PG-H: Saved-query endpoints - the mirror of Stripe's `I`.
 *
 * `I` deliberately stores `SELECT 1` and never executes anything against the
 * connector, because a saved query's inputQuery is just text - which makes it
 * the cheapest scenario in that suite. This version does the CRUD half exactly
 * the same way, then goes one step further and RUNS the saved query against a
 * real Postgres table, because that is where the connectors differ:
 *
 *   Stripe:   a saved query over `customers` returns at most ~100 rows
 *   Postgres: the same shape returns the whole table
 *
 * So the execute-by-name step doubles as a fourth route to the cap finding,
 * after queries (PG-B), exports (PG-C) and materialization (PG-D).
 *
 * The project contains unrelated pre-existing queries, so every assertion
 * looks for OUR query by id rather than asserting on list length.
 */
async function runPgQueries(ctx) {
  const displayName = `e2e_auto_pg_query_${ctx.runTag}`.replace(/-/g, "_");
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

  await step("update the query to read a real Postgres table", async () => {
    const updatedSql = `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}"`;
    const res = await ctx.client.updateQuery(queryId, { inputQuery: updatedSql });
    assertStatus(res, 200, "updateQuery");

    const after = await ctx.client.getQuery(queryId);
    assertStatus(after, 200, "getQuery after update");
    assertEqual(after.body.inputQuery, updatedSql, "inputQuery after update");
    // Omitted fields keep their values, per the reference.
    assertEqual(after.body.displayName, displayName, "displayName survives an inputQuery-only update");
  });

  // A saved query is addressable as "peaka"."query"."<name>" - `name` being the
  // SQL-queryable form, distinct from displayName. Same mechanism `I` uses.
  //
  // AND THE ROW COUNT IS THE POINT: running this against Stripe would return
  // the cap. Here it must return the whole table.
  await step("running the saved query returns the whole table, not the live cap", async () => {
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
    // Same split as pg-d-materialized-queries.js: the assertEqual above is the
    // real claim and holds at any size; beating Stripe's cap needs a table
    // bigger than the cap to mean anything.
    if (rows > ctx.expectedCustomerCountNonCache) {
      console.log(`saved query sees ${rows} rows - Stripe's equivalent would see ${ctx.expectedCustomerCountNonCache}`);
    } else {
      note(
        `saved query sees all ${rows} rows. Too few to also demonstrate it beats Stripe's ` +
          `${ctx.expectedCustomerCountNonCache}-row cap - that half is skipped.`
      );
    }
  });

  await step("transpile SQL to another dialect", async () => {
    const res = await ctx.client.transpileSql("postgres", 'SELECT * FROM "a"."b"."c" WHERE id = 1');
    assertStatus(res, 200, "transpileSql(postgres)");
    // DOCS DIVERGENCE (2026-07-29, see i-queries.js): the reference documents
    // { result: string } but the API returns { query: string }. Accept either
    // so this does not break if they align the docs to the code.
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
    // Peaka returns 400 rather than 404 for a missing query - see i-queries.js.
    assertStatusIn(after, [400, 404], "getQuery after delete");
  });
}

module.exports = { runPgQueries };
