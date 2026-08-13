const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");

/**
 * Whether deleting a Peaka Table actually destroys what it held.
 *
 * WHY THIS PINS GOOD BEHAVIOUR, which is the unusual thing about it. Every
 * scenario in this folder opens with a best-effort "clean up any leftover table
 * from a previous run" step and then assumes it is working against a blank
 * slate. Nothing had ever verified that assumption. If delete were a soft
 * delete - flag the table, keep the rows - then a "fresh" table could quietly
 * carry a previous run's data and several currently-green assertions would be
 * passing by luck rather than by correctness. That would be invisible from
 * outside, which is exactly the kind of thing worth an explicit test.
 *
 * MEASURED 2026-08-11: delete is a genuine hard drop, of BOTH data and schema.
 *
 *   deleteInternalTable            -> 200, gone from listInternalTables()
 *   SELECT from the deleted table  -> 400 "Table '...' does not exist"
 *   recreate the SAME name         -> 200, but ONLY the 8 system columns exist
 *   SELECT a previously declared
 *     column on the recreated table-> 400 "Column 'name' cannot be resolved"
 *   COUNT(*) on the recreated table-> 0
 *
 * The schema half is the part most likely to surprise someone: recreating a
 * table by the same name does NOT restore the columns you declared on it. You
 * get a blank table carrying only Peaka's own system columns, and every
 * user-declared column has to be added again.
 *
 * _id IS NOT A PER-TABLE SEQUENCE. A row imported into the recreated table gets
 * an id well above the deleted rows' ids rather than restarting - the values
 * look globally monotonic across the project (snowflake-style). This scenario
 * asserts only NON-REUSE, not monotonicity: monotonic ordering is an internal
 * detail Peaka may legitimately change, whereas a REUSED id would mean a stale
 * reference silently resolving to an unrelated row, which is a real hazard.
 */
const TABLE_NAME = "e2e_auto_pt_delete_purge";

const COLUMNS = [
  { name: "name", dataType: "VARCHAR", displayName: "name", isNotNull: false, isUnique: false },
  { name: "n", dataType: "BIGINT", displayName: "n", isNotNull: false, isUnique: false },
];

const HEADER = ["name", "n"];
const SEED_ROWS = [
  { name: "alice", n: "1" },
  { name: "bob", n: "2" },
  { name: "carol", n: "3" },
];

// Peaka adds these to every Peaka Table without being asked - see
// helpers/peakaClient.js's addInternalTableColumns comment. "text" is the odd
// one out: no leading underscore, and it was never declared either.
const SYSTEM_COLUMNS = [
  "_id",
  "_version",
  "_created_time",
  "_created_by",
  "_last_modified_time",
  "_last_modified_by",
  "_session",
  "text",
];

async function runPtDeletePurge(ctx) {
  const qualified = `"peaka"."table"."${TABLE_NAME}"`;
  let deletedRowIds = [];

  function importRows(rows) {
    return ctx.client.createTableImport(TABLE_NAME, {
      file: rowsToCsv(HEADER, rows),
      mappings: HEADER.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
  }

  function track() {
    if (!ctx.createdInternalTableNames.includes(TABLE_NAME)) ctx.createdInternalTableNames.push(TABLE_NAME);
  }

  function untrack() {
    const idx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);
  }

  async function listedTableNames() {
    const list = await ctx.client.listInternalTables();
    return (list.body || []).map((t) => t.tableName);
  }

  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table and seed three rows", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    track();

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, COLUMNS);
    assertStatusIn(colRes, [200], "addInternalTableColumns");

    const importRes = await importRows(SEED_ROWS);
    assertStatusIn(importRes, [200], "createTableImport (seed)");

    const sel = await ctx.client.executeQuery({ statement: `SELECT _id, name FROM ${qualified}` }, "SIMPLE");
    assertStatusIn(sel, [200], "SELECT the seeded rows");
    deletedRowIds = sel.body.data.map((r) => String(r._id));
    assertEqual(deletedRowIds.length, 3, "seeded rows to capture ids from");
    console.log(`  seeded ids captured for the non-reuse check: ${JSON.stringify(deletedRowIds)}`);
  });

  await step("the listing and SQL agree the deleted table is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    untrack();

    const names = await listedTableNames();
    assert(!names.includes(TABLE_NAME), `'${TABLE_NAME}' still appears in listInternalTables() after delete`);

    // The listing and the query engine must agree. A table absent from the
    // listing but still selectable would be the worst of both worlds.
    const sel = await ctx.client.executeQuery({ statement: `SELECT COUNT(*) FROM ${qualified}` }, "SIMPLE");
    assertStatusIn(sel, [400], "SELECT from a deleted table");
    const message = String((sel.body && sel.body.message) || "");
    assert(
      message.includes(TABLE_NAME),
      `The error for querying a deleted table does not name the table. Got: ${message.slice(0, 200)}`
    );
    console.log(`  SELECT after delete -> 400 ${message.slice(0, 90)}`);
  });

  // THE HEADLINE.
  await step("recreating the same name gives a blank table with no declared columns", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable (same name, second time)");
    track();

    const colRes = await ctx.client.listInternalTableColumns(TABLE_NAME);
    assertStatusIn(colRes, [200], "listInternalTableColumns on the recreated table");
    const columnNames = (colRes.body || []).map((c) => c.name || c.columnName);

    for (const declared of COLUMNS) {
      assert(
        !columnNames.includes(declared.name),
        `Column '${declared.name}' survived a delete/recreate cycle. Declared columns are supposed to be ` +
          `destroyed with the table - if they now persist, the recreate is reviving old schema and this ` +
          `folder's "clean up leftover table" steps no longer guarantee a blank slate. Columns: ${JSON.stringify(columnNames)}`
      );
    }
    assertEqual(
      columnNames.length,
      SYSTEM_COLUMNS.length,
      `columns on a freshly recreated table (expected only Peaka's system columns). Got ${JSON.stringify(
        columnNames
      )} - if Peaka has added a new system column, update SYSTEM_COLUMNS in this file`
    );

    // Querying a destroyed column must fail by name, not return NULLs.
    const sel = await ctx.client.executeQuery({ statement: `SELECT name FROM ${qualified}` }, "SIMPLE");
    assertStatusIn(sel, [400], "SELECT a destroyed column on the recreated table");

    const countRes = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM ${qualified}` },
      "SIMPLE"
    );
    assertStatusIn(countRes, [200], "COUNT(*) on the recreated table");
    assertEqual(Number(countRes.body.data[0].cnt), 0, "rows in a recreated table (data must not survive delete)");
    console.log("  recreated table: 0 rows, only system columns, declared columns gone");
  });

  await step("a re-seeded row never reuses a deleted row's id", async () => {
    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, COLUMNS);
    assertStatusIn(colRes, [200], "addInternalTableColumns (re-declared after recreate)");

    const importRes = await importRows([{ name: "zed", n: "9" }]);
    assertStatusIn(importRes, [200], "createTableImport (re-seed)");

    const sel = await ctx.client.executeQuery({ statement: `SELECT _id, name FROM ${qualified}` }, "SIMPLE");
    assertStatusIn(sel, [200], "SELECT the re-seeded row");
    assertEqual(sel.body.data.length, 1, "rows after re-seeding one row into the recreated table");

    const newId = String(sel.body.data[0]._id);
    assert(
      !deletedRowIds.includes(newId),
      `The re-seeded row reused _id ${newId}, which belonged to a row deleted with the old table ` +
        `(${JSON.stringify(deletedRowIds)}). A recycled id means anything holding a reference to the old ` +
        `row would silently resolve to this unrelated one.`
    );
    console.log(`  re-seeded id ${newId} does not collide with any deleted id`);
  });

  await step("delete the table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    untrack();

    const names = await listedTableNames();
    assert(!names.includes(TABLE_NAME), `'${TABLE_NAME}' still appears in listInternalTables() after delete`);
  });
}

module.exports = { runPtDeletePurge };
