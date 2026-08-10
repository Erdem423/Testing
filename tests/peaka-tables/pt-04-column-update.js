const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * PT-04: Column update and delete (Peaka Table).
 *
 * updateInternalTableColumn needs the FULL column body, not a partial patch
 * - see helpers/peakaClient.js's comment on it. Verified 2026-08-06.
 */
const TABLE_NAME = "e2e_auto_pt_column_update";

async function runPtColumnUpdate(ctx) {
  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table with col_a (VARCHAR) and col_b (BIGINT)", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, [
      { name: "col_a", dataType: "VARCHAR", displayName: "original a", defaultValue: null, isNotNull: false, isUnique: false },
      { name: "col_b", dataType: "BIGINT", displayName: "original b", defaultValue: null, isNotNull: false, isUnique: false },
    ]);
    assertStatusIn(colRes, [200], "addInternalTableColumns");
  });

  await step("update col_a's displayName", async () => {
    const res = await ctx.client.updateInternalTableColumn(TABLE_NAME, "col_a", {
      name: "col_a",
      dataType: "VARCHAR",
      displayName: "renamed a",
      defaultValue: null,
      isNotNull: false,
      isUnique: false,
    });
    assertStatusIn(res, [200], "updateInternalTableColumn");

    const list = await ctx.client.listInternalTableColumns(TABLE_NAME);
    assertStatusIn(list, [200], "listInternalTableColumns after update");
    const colA = (list.body || []).find((c) => c.name === "col_a");
    assert(colA, "col_a is missing from the column list after updating it");
    assertEqual(colA.displayName, "renamed a", "col_a's displayName after update");
  });

  await step("delete col_b", async () => {
    const res = await ctx.client.deleteInternalTableColumn(TABLE_NAME, "col_b");
    assertStatusIn(res, [200], "deleteInternalTableColumn");
  });

  await step("col_b is gone from the list and from SELECT", async () => {
    const list = await ctx.client.listInternalTableColumns(TABLE_NAME);
    assertStatusIn(list, [200], "listInternalTableColumns after delete");
    const names = (list.body || []).map((c) => c.name);
    assert(!names.includes("col_b"), `col_b still appears in the column list: ${JSON.stringify(names)}`);
    assert(names.includes("col_a"), `col_a should still be present: ${JSON.stringify(names)}`);
    const colA = (list.body || []).find((c) => c.name === "col_a");
    assertEqual(colA.displayName, "renamed a", "col_a's displayName survives the unrelated column delete");

    const sel = await ctx.client.executeQuery(
      { statement: `SELECT col_b FROM "peaka"."table"."${TABLE_NAME}"` },
      "SIMPLE"
    );
    assert(
      sel.status >= 400 && sel.status < 500,
      `Expected a 4xx selecting a deleted column, got ${sel.status}: ${JSON.stringify(sel.body)}`
    );
  });

  await step("delete the table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    const idx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const list = await ctx.client.listInternalTables();
    const stillPresent = (list.body || []).some((t) => t.tableName === TABLE_NAME);
    assert(!stillPresent, `'${TABLE_NAME}' still appears in listInternalTables() after delete`);
  });
}

module.exports = { runPtColumnUpdate };
