const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * Saved-query endpoints, HubSpot version of tests/stripe/i-queries.js.
 * Needs no catalog or connection of its own - a saved query's `inputQuery`
 * is just stored text - so this is identical to the Stripe version except
 * for the one step that executes a real query against real catalog data.
 *
 * The project contains unrelated pre-existing queries, so every assertion
 * looks for OUR query by id rather than asserting on list length.
 */
async function runQueries(ctx) {
  const displayName = `e2e-auto-query-${ctx.runTag}`;
  const originalSql = 'SELECT 1 AS one';
  const updatedSql = 'SELECT 2 AS two';
  let queryId = null;

  await step("create a saved query", async () => {
    const res = await ctx.client.createQuery({
      displayName,
      inputQuery: originalSql,
      queryType: "PLAIN",
    });
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

  await step("update the query's SQL", async () => {
    const res = await ctx.client.updateQuery(queryId, { inputQuery: updatedSql });
    assertStatus(res, 200, "updateQuery");

    const after = await ctx.client.getQuery(queryId);
    assertStatus(after, 200, "getQuery after update");
    assertEqual(after.body.inputQuery, updatedSql, "inputQuery after update");
    assertEqual(after.body.displayName, displayName, "displayName should survive a partial update");
  });

  await step("execute the saved query by id", async () => {
    // Uses a query with real SQL behind it, against the pre-existing HubSpot
    // catalog - the CRUD steps above use 'SELECT 1', fine to store but
    // pointless to execute. Same id-not-queryId shape as Stripe's version
    // (see tests/stripe/i-queries.js) - that's a Peaka API behavior, not a
    // connector-specific one, so no reason to expect it differs here.
    const realQuery = await ctx.client.createQuery({
      displayName: `e2e-auto-exec-${ctx.runTag}`,
      inputQuery: `SELECT id FROM "${ctx.catalogNameFromConfig || "hubspot"}"."${ctx.schemaName}"."contacts" LIMIT 5`,
      queryType: "PLAIN",
    });
    assertStatus(realQuery, 200, "createQuery (for execution)");
    const execId = realQuery.body.id;
    ctx.createdQueryIds.push(execId);

    const res = await ctx.client.executeQuery({ id: execId }, "SIMPLE");
    assertStatus(res, 200, "executeQuery by saved-query id");
    assert(Array.isArray(res.body.data), `Expected a data array, got: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(
      Array.isArray(res.body.columns) && res.body.columns.length > 0,
      "Expected column metadata on the execute-by-id response"
    );
  });

  await step("execute the saved query by its qualified name", async () => {
    const created = await ctx.client.createQuery({
      displayName: `e2e-auto-named-${ctx.runTag}`,
      inputQuery: "SELECT 42 AS answer",
      queryType: "PLAIN",
    });
    assertStatus(created, 200, "createQuery (for name execution)");
    ctx.createdQueryIds.push(created.body.id);
    const sqlName = created.body.name;
    assert(sqlName, `Expected a SQL-queryable name on the created query: ${JSON.stringify(created.body)}`);

    const res = await ctx.client.executeQuery(
      { statement: `SELECT * FROM "peaka"."query"."${sqlName}"` },
      "SIMPLE"
    );
    assertStatus(res, 200, "executeQuery by qualified name");
    assert(res.body.data.length > 0, "Expected the named query to return its row");
  });

  await step("transpile SQL to another dialect", async () => {
    // Project-independent endpoint - identical to the Stripe version.
    const res = await ctx.client.transpileSql("mysql", 'SELECT * FROM "a"."b"."c" WHERE id = 1');
    assertStatus(res, 200, "transpileSql(mysql)");
    const transpiled = res.body && (res.body.query || res.body.result);
    assert(
      typeof transpiled === "string" && transpiled.length > 0,
      `Expected a transpiled SQL string in { query } or { result }, got: ${JSON.stringify(res.body)}`
    );
    assert(
      transpiled.includes("`"),
      `Expected MySQL-dialect backtick quoting in the transpiled SQL, got: ${transpiled}`
    );
  });

  await step("delete the query and confirm it is gone", async () => {
    const res = await ctx.client.deleteQuery(queryId);
    assertStatus(res, 200, "deleteQuery");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== queryId);

    const after = await ctx.client.getQuery(queryId);
    assertStatusIn(after, [400, 404], "getQuery after delete");
    assert(
      after.body && typeof after.body.message === "string" && after.body.message.length > 0,
      `Expected an explanatory error message for a deleted query, got: ${JSON.stringify(after.body)}`
    );
  });
}

module.exports = { runQueries };
