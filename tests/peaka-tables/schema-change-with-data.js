const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");

/**
 * Changing a table's schema while it already holds rows.
 *
 * WHY THIS IS THE MOST CUSTOMER-SHAPED SCENARIO IN THE FOLDER. Every other
 * scenario here declares its columns up front and never touches them again.
 * Real tables do not work that way: someone loads customer data, and two weeks
 * later the business needs one more field. Adding a column to a POPULATED
 * table is the single most common thing that happens to a table after it is
 * created, and dropping one is the ONLY surgical way to remove data from a
 * Peaka Table at all - there is no row-level DELETE (FINDINGS 11), so a
 * "delete this column, it holds data we should not keep" request has exactly
 * one available answer.
 *
 * MEASURED 2026-08-11 - all of this WORKS, and the scenario pins it:
 *
 *   add a column to a table with rows  -> 200, existing rows read NULL for it
 *   import carrying the new column     -> 200, only the new row is populated
 *   delete a column that holds data    -> 200, every other column survives
 *   SELECT the dropped column          -> 400 "Column 'x' cannot be resolved"
 *   change a column's displayName      -> import mappings still bind
 *
 * THE displayName STEP IS NOT COSMETIC. Import mappings are keyed on the
 * column's `name`, while `displayName` is what a BI tool shows. If Peaka ever
 * started resolving mappings against displayName, every existing import script
 * would break the moment someone relabelled a column in the UI - a failure the
 * customer would experience as "my nightly load stopped working" with nothing
 * in their own code having changed. Cheap to pin, expensive to discover late.
 *
 * ONE INTERACTION WORTH KNOWING, not asserted here because FINDINGS 20 owns
 * it: re-importing an updated CSV after adding a column does NOT update the
 * existing rows. Import appends, so the customer ends up with the old rows
 * (NULL in the new column) AND fresh duplicates. The natural fix for "my old
 * rows are missing the new field" is the one thing that makes it worse.
 */
const TABLE_NAME = "e2e_auto_pt_schema_change";

const col = (name, dataType, extra = {}) => ({
  name,
  dataType,
  displayName: name,
  defaultValue: null,
  isNotNull: false,
  isUnique: false,
  ...extra,
});

async function runPtSchemaChange(ctx) {
  const qualified = `"peaka"."table"."${TABLE_NAME}"`;

  function importRows(header, rows) {
    return ctx.client.createTableImport(TABLE_NAME, {
      file: rowsToCsv(header, rows),
      mappings: header.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
  }

  async function selectRows(statement) {
    const res = await ctx.client.executeQuery({ statement }, "SIMPLE");
    assertStatusIn(res, [200], "SELECT");
    return res.body.data;
  }

  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table with col_a and col_b then seed two rows", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, [col("col_a", "VARCHAR"), col("col_b", "BIGINT")]);
    assertStatusIn(colRes, [200], "addInternalTableColumns");

    const importRes = await importRows(["col_a", "col_b"], [
      { col_a: "alice", col_b: "1" },
      { col_a: "bob", col_b: "2" },
    ]);
    assertStatusIn(importRes, [200], "createTableImport (seed)");
    assertEqual((await selectRows(`SELECT col_a FROM ${qualified}`)).length, 2, "seeded rows");
  });

  await step("a column added to a populated table reads NULL for the existing rows", async () => {
    const addRes = await ctx.client.addInternalTableColumns(TABLE_NAME, [col("col_c", "VARCHAR")]);
    assertStatusIn(addRes, [200], "addInternalTableColumns on a populated table");

    const rows = await selectRows(`SELECT col_a, col_c FROM ${qualified}`);
    assertEqual(rows.length, 2, "rows after adding a column (adding one must not drop or duplicate rows)");
    for (const row of rows) {
      assert(
        row.col_c === null,
        `The pre-existing row '${row.col_a}' reads ${JSON.stringify(row.col_c)} for col_c, expected NULL. ` +
          `Anything else would mean Peaka invented a value for data that predates the column.`
      );
    }
  });

  await step("an import carrying the new column populates only the new row", async () => {
    const res = await importRows(["col_a", "col_b", "col_c"], [{ col_a: "carol", col_b: "3", col_c: "new" }]);
    assertStatusIn(res, [200], "createTableImport (with the new column)");

    const rows = await selectRows(`SELECT col_a, col_c FROM ${qualified}`);
    assertEqual(rows.length, 3, "rows after importing one more");
    const carol = rows.find((r) => r.col_a === "carol");
    assert(carol, "the newly imported row is missing");
    assertEqual(carol.col_c, "new", "col_c on the newly imported row");
    // The pre-existing rows must stay NULL: an import is not a backfill.
    for (const name of ["alice", "bob"]) {
      assertEqual(rows.find((r) => r.col_a === name).col_c, null, `col_c on the pre-existing row '${name}'`);
    }
  });

  // THE HEADLINE. Dropping a column is the only way to remove data from a
  // Peaka Table without destroying the whole table, so it has to be surgical.
  await step("deleting a column that holds data leaves every other column intact", async () => {
    const delRes = await ctx.client.deleteInternalTableColumn(TABLE_NAME, "col_b");
    assertStatusIn(delRes, [200], "deleteInternalTableColumn on a column holding data");

    const rows = await selectRows(`SELECT col_a, col_c FROM ${qualified}`);
    assertEqual(rows.length, 3, "rows after dropping a populated column (dropping a column must not drop rows)");
    assertEqual(rows.find((r) => r.col_a === "carol").col_c, "new", "col_c survived the drop of col_b");

    // Gone means gone: a dropped column must fail to resolve, not come back
    // as NULL, or a caller cannot tell "removed" from "empty".
    const gone = await ctx.client.executeQuery({ statement: `SELECT col_b FROM ${qualified}` }, "SIMPLE");
    assertStatusIn(gone, [400], "SELECT of the dropped column");
    const message = String((gone.body && gone.body.message) || "");
    assert(
      message.includes("col_b"),
      `The error for selecting a dropped column does not name it. Got: ${message.slice(0, 160)}`
    );
  });

  await step("renaming a column's displayName does not break import mappings", async () => {
    const updRes = await ctx.client.updateInternalTableColumn(TABLE_NAME, "col_a", {
      name: "col_a",
      dataType: "VARCHAR",
      displayName: "Renamed Label",
      defaultValue: null,
      isNotNull: false,
      isUnique: false,
    });
    assertStatusIn(updRes, [200], "updateInternalTableColumn (displayName)");

    // Mapping still uses `name`, which is the whole point of the check.
    const res = await importRows(["col_a", "col_c"], [{ col_a: "dave", col_c: "after-rename" }]);
    assertStatusIn(res, [200], "createTableImport after a displayName change");

    const rows = await selectRows(`SELECT col_a, col_c FROM ${qualified}`);
    const dave = rows.find((r) => r.col_a === "dave");
    assert(
      dave,
      `The row imported after the displayName change is missing. Mappings are keyed on the column NAME, ` +
        `so relabelling a column must not break them - if Peaka has started resolving mappings against ` +
        `displayName instead, every existing import script breaks the moment someone relabels a column ` +
        `in the UI, with nothing in the caller's own code having changed.`
    );
    assertEqual(dave.col_c, "after-rename", "col_c on the row imported after the rename");
  });

  await step("delete the table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    const idx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const list = await ctx.client.listInternalTables();
    assert(
      !(list.body || []).some((t) => t.tableName === TABLE_NAME),
      `'${TABLE_NAME}' still appears in listInternalTables() after delete`
    );
  });
}

module.exports = { runPtSchemaChange };
