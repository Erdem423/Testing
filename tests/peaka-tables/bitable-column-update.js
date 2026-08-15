const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * BI Table silently ignores displayName on every column change - the mirror of
 * the Peaka Table column-update scenario, adapted around a real divergence
 * verified 2026-08-06.
 *
 * Two independent bitable bugs are in play here - see
 * helpers/peakaClient.js's addBiTableColumns comment for the full
 * separation:
 *
 *   1. Column names are stripped of underscores ("col_a" -> "cola"), the
 *      same way table names are.
 *   2. displayName is ALWAYS overwritten with the column's own name,
 *      whether or not it had underscores.
 *
 * Bug 2 is the significant one, and it applies at creation AND update.
 * Calling updateBiTableColumn returns 200 with a body that ECHOES the
 * requested displayName back as if it worked - but a subsequent list (even
 * after a 3s wait, ruling out propagation lag) shows displayName still
 * equal to the column name. The update response LIES about what happened.
 * Compare the Peaka Table equivalent: it respects displayName correctly at
 * both create and update time - so this is BI-Table-specific, not a general
 * limitation.
 *
 * Column DELETE is unaffected by any of this - verified separately to
 * behave exactly like Peaka Table's.
 *
 * This scenario pins the real behavior. If BI Table's displayName ever
 * starts persisting, the update step below should start failing its
 * "still equals the column name" assertion - that's deliberate, and means
 * this file needs updating to assert the fix instead.
 */
const REQUESTED_NAME = "e2e_auto_bt_column_update";

async function runBtColumnUpdate(ctx) {
  let tableName;
  let colA; // the actual, underscore-stripped name of "col_a"
  let colB; // the actual, underscore-stripped name of "col_b"

  await step("clean up any leftover table from a previous run", async () => {
    for (const candidate of new Set([REQUESTED_NAME, REQUESTED_NAME.replace(/_/g, "")])) {
      await ctx.client.deleteBiTable(candidate).catch(() => {});
    }
  });

  await step("create the BI Table with col_a (VARCHAR) and col_b (BIGINT)", async () => {
    const createRes = await ctx.client.createBiTable(REQUESTED_NAME);
    assertStatusIn(createRes, [200], "createBiTable");
    tableName = createRes.body.tableName;
    assert(tableName, `createBiTable returned no tableName: ${JSON.stringify(createRes.body)}`);
    ctx.createdBiTableNames.push(tableName);

    const colRes = await ctx.client.addBiTableColumns(tableName, [
      { name: "col_a", dataType: "VARCHAR", displayName: "original a", defaultValue: null, isNotNull: false, isUnique: false },
      { name: "col_b", dataType: "BIGINT", displayName: "original b", defaultValue: null, isNotNull: false, isUnique: false },
    ]);
    assertStatusIn(colRes, [200], "addBiTableColumns");

    const list = await ctx.client.listBiTableColumns(tableName);
    assertStatusIn(list, [200], "listBiTableColumns after create");
    const names = (list.body || []).map((c) => c.name);
    colA = names.includes("cola") ? "cola" : "col_a"; // defensive, in case this ever changes
    colB = names.includes("colb") ? "colb" : "col_b";
    assert(names.includes(colA), `Expected a stripped 'cola' column, got: ${JSON.stringify(names)}`);
    assert(names.includes(colB), `Expected a stripped 'colb' column, got: ${JSON.stringify(names)}`);

    const colAEntry = (list.body || []).find((c) => c.name === colA);
    assertEqual(colAEntry.displayName, colA, "displayName at creation, contrary to the requested 'original a'");
  });

  await step("update col_a's displayName", async () => {
    const res = await ctx.client.updateBiTableColumn(tableName, colA, {
      name: colA,
      dataType: "VARCHAR",
      displayName: "renamed a",
      defaultValue: null,
      isNotNull: false,
      isUnique: false,
    });
    assertStatusIn(res, [200], "updateBiTableColumn");

    // NOT the doc's expected "PtColList reflects the new displayName" - that
    // is Peaka Table's real behavior, not BI Table's. Here the displayName
    // does not persist, though the update call itself succeeds and its
    // response falsely echoes the requested value.
    const list = await ctx.client.listBiTableColumns(tableName);
    assertStatusIn(list, [200], "listBiTableColumns after update");
    const entry = (list.body || []).find((c) => c.name === colA);
    assert(entry, `${colA} is missing from the column list after updating it`);
    assertEqual(
      entry.displayName,
      colA,
      `Expected displayName to still be '${colA}' (the update doesn't persist, as measured) - if this now ` +
        `reads 'renamed a', BI Table's displayName update has started working and this assertion needs flipping.`
    );
  });

  await step("delete col_b", async () => {
    const res = await ctx.client.deleteBiTableColumn(tableName, colB);
    assertStatusIn(res, [200], "deleteBiTableColumn");
  });

  await step("col_b is gone from the list and from SELECT", async () => {
    const list = await ctx.client.listBiTableColumns(tableName);
    assertStatusIn(list, [200], "listBiTableColumns after delete");
    const names = (list.body || []).map((c) => c.name);
    assert(!names.includes(colB), `${colB} still appears in the column list: ${JSON.stringify(names)}`);
    assert(names.includes(colA), `${colA} should still be present: ${JSON.stringify(names)}`);

    const sel = await ctx.client.executeQuery(
      { statement: `SELECT ${colB} FROM "peaka"."bitable"."${tableName}"` },
      "SIMPLE"
    );
    assert(
      sel.status >= 400 && sel.status < 500,
      `Expected a 4xx selecting a deleted column, got ${sel.status}: ${JSON.stringify(sel.body)}`
    );
  });

  await step("delete the BI Table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteBiTable(tableName);
    assertStatusIn(delRes, [200], "deleteBiTable");
    const idx = ctx.createdBiTableNames.indexOf(tableName);
    if (idx !== -1) ctx.createdBiTableNames.splice(idx, 1);

    const list = await ctx.client.listBiTables();
    const stillPresent = (list.body || []).some((t) => t.tableName === tableName);
    assert(!stillPresent, `'${tableName}' still appears in listBiTables() after delete`);
  });
}

module.exports = { runBtColumnUpdate };
