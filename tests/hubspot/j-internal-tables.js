const { assertStatus, assert, assertEqual, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * Peaka internal ("Peaka Table") endpoints, HubSpot version of
 * tests/stripe/j-internal-tables.js. This endpoint group is project-level
 * and has nothing to do with any connector - the content is identical to the
 * Stripe version, duplicated per-connector only because server.js's
 * testMatch is scoped to jest/<connector>/**\/*.test.js (see README's
 * "Adding another connector"), not because anything here differs.
 */
async function runInternalTables(ctx) {
  const tableName = `e2e_auto_table_${String(ctx.runTag).replace(/[^a-z0-9]/gi, "_")}`;

  await step("create an internal table", async () => {
    const res = await ctx.client.createInternalTable(tableName);
    assertStatus(res, 200, `createInternalTable(${tableName})`);
    assertEqual(res.body.tableName, tableName, "created tableName");
    ctx.createdInternalTableNames.push(tableName);
  });

  await step("list internal tables includes the new one", async () => {
    const res = await ctx.client.listInternalTables();
    assertStatus(res, 200, "listInternalTables");
    assert(Array.isArray(res.body), "Expected an array of internal tables");
    assert(
      res.body.some((t) => t.tableName === tableName),
      `Newly created internal table '${tableName}' not found in listInternalTables`
    );
  });

  await step("add columns to the table", async () => {
    const res = await ctx.client.addInternalTableColumns(tableName, [
      { name: "contact_id", dataType: "VARCHAR", displayName: "Contact ID", isNotNull: false, isUnique: false },
      { name: "segment", dataType: "VARCHAR", displayName: "Segment", isNotNull: false, isUnique: false },
      { name: "score", dataType: "BIGINT", displayName: "Score", isNotNull: false, isUnique: false },
    ]);
    assertStatus(res, 200, "addInternalTableColumns");
  });

  await step("list columns reflects what was added", async () => {
    const res = await ctx.client.listInternalTableColumns(tableName);
    assertStatus(res, 200, "listInternalTableColumns");
    const names = res.body.map((c) => c.name || c.columnName);
    for (const expected of ["contact_id", "segment", "score"]) {
      assertIncludes(names, expected, `${tableName} columns`);
    }
    const score = res.body.find((c) => (c.name || c.columnName) === "score");
    assert(
      score && String(score.dataType).toUpperCase().includes("BIGINT"),
      `Expected 'score' to keep its BIGINT type, got: ${JSON.stringify(score)}`
    );
  });

  await step("delete a column", async () => {
    const res = await ctx.client.deleteInternalTableColumn(tableName, "score");
    assertStatus(res, 200, "deleteInternalTableColumn(score)");

    const after = await ctx.client.listInternalTableColumns(tableName);
    assertStatus(after, 200, "listInternalTableColumns after delete");
    const names = after.body.map((c) => c.name || c.columnName);
    assert(!names.includes("score"), `Column 'score' still present after deletion: ${names.join(", ")}`);
    assertIncludes(names, "segment", "remaining columns");
  });

  await step("delete the table and confirm it is gone", async () => {
    const res = await ctx.client.deleteInternalTable(tableName);
    assertStatus(res, 200, `deleteInternalTable(${tableName})`);
    ctx.createdInternalTableNames = ctx.createdInternalTableNames.filter((n) => n !== tableName);

    const list = await ctx.client.listInternalTables();
    assertStatus(list, 200, "listInternalTables after delete");
    assert(
      !list.body.some((t) => t.tableName === tableName),
      `Deleted internal table '${tableName}' still appears in listInternalTables`
    );
  });
}

module.exports = { runInternalTables };
