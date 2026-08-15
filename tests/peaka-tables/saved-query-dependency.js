const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");

/**
 * What happens to a saved query when the table underneath it changes.
 *
 * WHY A CUSTOMER HITS THIS. A saved query is what a dashboard is built on. The
 * first time anyone tidies a project - drops a column nobody uses, reloads a
 * table - they are changing the ground a saved query stands on, without ever
 * opening the query itself. Nothing in the API warns them.
 *
 * A saved query is addressable as a virtual table at "peaka"."query"."<name>",
 * where <name> is getQuery(id).body.name and NOT displayName - the same
 * mechanic tests/postgres/pg-h-queries.js uses.
 *
 * MEASURED 2026-08-11, and the important thing is that the query OBJECT and
 * the query EXECUTION fail independently:
 *
 *   drop a column the query SELECTs -> running it: 400 "Column 'x' cannot be
 *                                      resolved". getQuery: still 200, and
 *                                      inputQuery is unchanged.
 *   delete the whole table          -> running it: 400 "Table '...' does not
 *                                      exist". getQuery: still 200, still in
 *                                      listQueries().
 *   recreate the table, same name,  -> running it SUCCEEDS and returns the
 *   different data                     NEW data. The query silently re-binds.
 *
 * NO 5xx AT ANY POINT, which was the one invariant worth asserting before
 * measuring: a dangling reference must degrade into a clean 4xx, not crash.
 * FINDINGS 3 is the precedent for caring - deleting a cache once left a table
 * permanently unreachable through Peaka.
 *
 * THE RE-BIND IS THE FINDING, and it cuts both ways. Peaka stores the saved
 * query as SQL TEXT and resolves the table name at execution time, so a
 * recreated table is picked up automatically. That is exactly what you want
 * when you reload a table you own. It is exactly what you do NOT want when
 * somebody else creates an unrelated table that happens to reuse the name:
 * the dashboard keeps working and quietly starts reporting different data,
 * with no error anywhere to notice.
 *
 * Deleting a table never deletes queries that point at it, so a project
 * accumulates queries that are broken until the name reappears.
 */
const TABLE_NAME = "e2e_auto_pt_saved_query";

const col = (name) => ({
  name,
  dataType: "VARCHAR",
  displayName: name,
  defaultValue: null,
  isNotNull: false,
  isUnique: false,
});

const HEADER = ["keep", "doomed"];
const ORIGINAL_ROWS = [
  { keep: "k1", doomed: "d1" },
  { keep: "k2", doomed: "d2" },
  { keep: "k3", doomed: "d3" },
];
const REPLACEMENT_ROW = { keep: "REBOUND", doomed: "REBOUND_D" };

async function runPtSavedQuery(ctx) {
  const qualifiedTable = `"peaka"."table"."${TABLE_NAME}"`;
  let queryId = null;
  let qualifiedQuery = null;

  function importRows(rows) {
    return ctx.client.createTableImport(TABLE_NAME, {
      file: rowsToCsv(HEADER, rows),
      mappings: HEADER.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
  }

  async function createTableAndSeed(rows) {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    if (!ctx.createdInternalTableNames.includes(TABLE_NAME)) ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, [col("keep"), col("doomed")]);
    assertStatusIn(colRes, [200], "addInternalTableColumns");

    const importRes = await importRows(rows);
    assertStatusIn(importRes, [200], "createTableImport");
  }

  /** Runs the saved query as a virtual table and returns the raw response. */
  function runSavedQuery(statement) {
    return ctx.client.executeQuery({ statement: statement || `SELECT * FROM ${qualifiedQuery}` }, "SIMPLE");
  }

  await step("clean up any leftover table and query from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
    const list = await ctx.client.listQueries().catch(() => ({ body: [] }));
    for (const q of list.body || []) {
      if (String(q.displayName || "").startsWith("e2e_auto_pt_saved_query")) {
        await ctx.client.deleteQuery(q.id).catch(() => {});
      }
    }
  });

  await step("create the table seed three rows and a saved query over it", async () => {
    await createTableAndSeed(ORIGINAL_ROWS);

    const created = await ctx.client.createQuery({
      displayName: `e2e_auto_pt_saved_query_${ctx.runTag}`,
      inputQuery: `SELECT keep, doomed FROM ${qualifiedTable}`,
      queryType: "PLAIN",
    });
    assertStatusIn(created, [200], "createQuery over an internal table");
    queryId = created.body.id;
    ctx.createdQueryIds.push(queryId);

    // The SQL-addressable name is `name`, not `displayName`.
    const read = await ctx.client.getQuery(queryId);
    assertStatusIn(read, [200], "getQuery");
    assert(read.body.name, `Expected a SQL-queryable name: ${JSON.stringify(read.body).slice(0, 200)}`);
    qualifiedQuery = `"peaka"."query"."${read.body.name}"`;
  });

  await step("the saved query returns the same rows as the table underneath it", async () => {
    const res = await runSavedQuery(`SELECT keep, doomed FROM ${qualifiedQuery}`);
    assertStatusIn(res, [200], "running the saved query");
    assertEqual(res.body.data.length, ORIGINAL_ROWS.length, "rows visible through the saved query");
    for (const expected of ORIGINAL_ROWS) {
      assert(
        res.body.data.some((r) => r.keep === expected.keep && r.doomed === expected.doomed),
        `Row ${JSON.stringify(expected)} is missing from the saved query's result`
      );
    }
  });

  await step("dropping a column the query selects breaks execution but not the query", async () => {
    const dropRes = await ctx.client.deleteInternalTableColumn(TABLE_NAME, "doomed");
    assertStatusIn(dropRes, [200], "deleteInternalTableColumn");

    const res = await runSavedQuery();
    assertStatusIn(res, [400], "running a saved query whose column was dropped");
    const message = String((res.body && res.body.message) || "");
    assert(
      message.includes("doomed"),
      `The error does not name the dropped column, so a caller cannot tell which one broke. Got: ${message.slice(0, 180)}`
    );

    // The query OBJECT must survive untouched - only execution is affected.
    const read = await ctx.client.getQuery(queryId);
    assertStatusIn(read, [200], "getQuery after the column was dropped");
    assert(
      String(read.body.inputQuery || "").includes("doomed"),
      `Peaka rewrote the saved query's SQL when the column was dropped. inputQuery should be stored text, ` +
        `left exactly as written: ${JSON.stringify(read.body.inputQuery)}`
    );
  });

  await step("deleting the table leaves the query stored but unrunnable", async () => {
    const delRes = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    const idx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const res = await runSavedQuery();
    assertStatusIn(res, [400], "running a saved query whose table was deleted");
    const message = String((res.body && res.body.message) || "");
    assert(
      message.includes(TABLE_NAME),
      `The error does not name the missing table. Got: ${message.slice(0, 180)}`
    );

    // Deleting a table must not delete queries that reference it - otherwise
    // a cleanup would silently destroy dashboards nobody mentioned.
    const read = await ctx.client.getQuery(queryId);
    assertStatusIn(read, [200], "getQuery after its table was deleted");
    const list = await ctx.client.listQueries();
    assertStatusIn(list, [200], "listQueries after the table was deleted");
    assert(
      (list.body || []).some((q) => String(q.id) === String(queryId)),
      `The saved query vanished from listQueries() when its table was deleted. Deleting a table must ` +
        `never delete the queries built on top of it`
    );
  });

  // THE HEADLINE.
  await step("recreating the table under the same name silently re-binds the query", async () => {
    await createTableAndSeed([REPLACEMENT_ROW]);

    const res = await runSavedQuery(`SELECT keep, doomed FROM ${qualifiedQuery}`);
    assertStatusIn(
      res,
      [200],
      "running the saved query after its table was recreated (it resolves the name at execution time)"
    );
    assertEqual(res.body.data.length, 1, "rows visible through the re-bound saved query");
    // assert() rather than assertEqual(): the explanation is too long to read
    // well inside assertEqual's "Expected <label> to equal X" wrapper.
    assert(
      res.body.data[0].keep === REPLACEMENT_ROW.keep,
      `The re-bound saved query returned ${JSON.stringify(res.body.data[0].keep)}, expected ` +
        `${JSON.stringify(REPLACEMENT_ROW.keep)} - the NEW table's data. Peaka resolves the table name at ` +
        `execution time, so the query picks up whatever now holds that name with no warning: welcome when ` +
        `you reload a table you own, dangerous when someone else reuses the name, because the dashboard ` +
        `keeps working and quietly reports different data.`
    );
    console.log(`  FINDING: the orphaned query re-bound to the recreated table - ${JSON.stringify(res.body.data)}`);
  });

  await step("delete the query and the table and confirm both are gone", async () => {
    const delQuery = await ctx.client.deleteQuery(queryId);
    assertStatusIn(delQuery, [200, 204], "deleteQuery");
    const qIdx = ctx.createdQueryIds.indexOf(queryId);
    if (qIdx !== -1) ctx.createdQueryIds.splice(qIdx, 1);

    const delTable = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delTable, [200], "deleteInternalTable");
    const tIdx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (tIdx !== -1) ctx.createdInternalTableNames.splice(tIdx, 1);

    const list = await ctx.client.listInternalTables();
    assert(
      !(list.body || []).some((t) => t.tableName === TABLE_NAME),
      `'${TABLE_NAME}' still appears in listInternalTables() after delete`
    );
  });
}

module.exports = { runPtSavedQuery };
