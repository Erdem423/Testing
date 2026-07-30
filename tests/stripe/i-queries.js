const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * Saved-query endpoints: create -> list -> read -> update -> delete, plus SQL
 * transpilation.
 *
 * Needs no catalog or connection of its own - a saved query's `inputQuery` is
 * just stored text, so nothing here executes against Stripe. That makes this
 * the cheapest scenario in the suite.
 *
 * The project contains unrelated pre-existing queries (5 at time of writing),
 * so every assertion looks for OUR query by id rather than asserting on list
 * length.
 *
 * NOT covered here (request shapes couldn't be determined from the reference):
 * executing a saved query by id or name, and creating a MATERIALIZED query -
 * which is why the whole Materialized Queries group is absent.
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
    // Omitted fields should keep their values, per the reference.
    assertEqual(after.body.displayName, displayName, "displayName should survive a partial update");
  });

  // The execute endpoint takes a oneOf with four branches; the reference
  // names them but only expands the fields for two. Probing settled it
  // (2026-07-29): the saved-query branch keys off **`id`**, not `queryId`.
  // `queryId`, `queryRefId` and `savedQueryId` all return 400, and so does
  // passing the id as a JSON number rather than a string.
  await step("execute the saved query by id", async () => {
    // Uses a query with real SQL behind it - the CRUD steps above use
    // 'SELECT 1', which is fine to store but pointless to execute.
    const realQuery = await ctx.client.createQuery({
      displayName: `e2e-auto-exec-${ctx.runTag}`,
      inputQuery: `SELECT id FROM "${ctx.catalogNameFromConfig || "stripe"}"."${ctx.schemaName}"."customers" LIMIT 5`,
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

  // Executing by qualified NAME is the one branch still unresolved - four
  // candidate field shapes all returned 400. But saved queries ARE reachable
  // by name through the statement branch, which is what this asserts.
  await step("execute the saved query by its qualified name", async () => {
    const created = await ctx.client.createQuery({
      displayName: `e2e-auto-named-${ctx.runTag}`,
      inputQuery: "SELECT 42 AS answer",
      queryType: "PLAIN",
    });
    assertStatus(created, 200, "createQuery (for name execution)");
    ctx.createdQueryIds.push(created.body.id);
    // `name` is the SQL-queryable form, distinct from displayName.
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
    const res = await ctx.client.transpileSql("mysql", 'SELECT * FROM "a"."b"."c" WHERE id = 1');
    assertStatus(res, 200, "transpileSql(mysql)");
    // DOCS DIVERGENCE (2026-07-29): the reference documents the response as
    // { result: string }, but the API actually returns { query: string }.
    // Accept either so this doesn't break if they align the docs to the code
    // or vice versa.
    const transpiled = res.body && (res.body.query || res.body.result);
    assert(
      typeof transpiled === "string" && transpiled.length > 0,
      `Expected a transpiled SQL string in { query } or { result }, got: ${JSON.stringify(res.body)}`
    );
    // MySQL quotes identifiers with backticks rather than double quotes.
    assert(
      transpiled.includes("`"),
      `Expected MySQL-dialect backtick quoting in the transpiled SQL, got: ${transpiled}`
    );
  });

  await step("delete the query and confirm it is gone", async () => {
    const res = await ctx.client.deleteQuery(queryId);
    assertStatus(res, 200, "deleteQuery");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== queryId);

    // DOCS DIVERGENCE (confirmed 2026-07-29): Peaka returns 400, not the 404
    // the reference implies for a missing resource - e.g.
    //   {"errorCode":100,"message":"There is no query with id: 1210890979914023812"}
    // What actually matters is that it's a clean 4xx naming the problem
    // rather than a 5xx or a raw stack trace, so that's what's asserted.
    const after = await ctx.client.getQuery(queryId);
    assertStatusIn(after, [400, 404], "getQuery after delete");
    assert(
      after.body && typeof after.body.message === "string" && after.body.message.length > 0,
      `Expected an explanatory error message for a deleted query, got: ${JSON.stringify(after.body)}`
    );
  });
}

module.exports = { runQueries };
