const { assertStatus, assert, assertEqual, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * Peaka internal ("Peaka Table") endpoints: create table -> add columns ->
 * list tables/columns -> delete column -> delete table.
 *
 * Project-level, so no connection or catalog is needed. The project contains
 * unrelated pre-existing internal tables, so list assertions look for OUR
 * table by name rather than asserting on length.
 *
 * NOT covered here: INSERT into an internal table (request shape for writing
 * rows couldn't be determined), which is also why the cross-catalog join
 * scenario is absent.
 */
async function runInternalTables(ctx) {
  // Deliberately no spaces or punctuation - this name goes in a URL path.
  const tableName = `e2e_auto_table_${String(ctx.runTag).replace(/[^a-z0-9]/gi, "_")}`;
  let created = false;

  await step("create an internal table", async () => {
    const res = await ctx.client.createInternalTable(tableName);
    assertStatus(res, 200, `createInternalTable(${tableName})`);
    assertEqual(res.body.tableName, tableName, "created tableName");
    created = true;
    ctx.createdInternalTableNames.push(tableName);
  });

  await step("list internal tables includes the new one", async () => {
    if (!created) {
      console.log("skipped: table was not created (previous step failed)");
      return;
    }
    const res = await ctx.client.listInternalTables();
    assertStatus(res, 200, "listInternalTables");
    assert(Array.isArray(res.body), "Expected an array of internal tables");
    assert(
      res.body.some((t) => t.tableName === tableName),
      `Newly created internal table '${tableName}' not found in listInternalTables`
    );
  });

  await step("add columns to the table", async () => {
    if (!created) {
      console.log("skipped: table was not created");
      return;
    }
    const res = await ctx.client.addInternalTableColumns(tableName, [
      { name: "customer_id", dataType: "VARCHAR", displayName: "Customer ID", isNotNull: false, isUnique: false },
      { name: "segment", dataType: "VARCHAR", displayName: "Segment", isNotNull: false, isUnique: false },
      { name: "score", dataType: "BIGINT", displayName: "Score", isNotNull: false, isUnique: false },
    ]);
    assertStatus(res, 200, "addInternalTableColumns");
  });

  await step("list columns reflects what was added", async () => {
    if (!created) {
      console.log("skipped: table was not created");
      return;
    }
    const res = await ctx.client.listInternalTableColumns(tableName);
    assertStatus(res, 200, "listInternalTableColumns");
    const names = res.body.map((c) => c.name || c.columnName);
    for (const expected of ["customer_id", "segment", "score"]) {
      assertIncludes(names, expected, `${tableName} columns`);
    }
    const score = res.body.find((c) => (c.name || c.columnName) === "score");
    assert(
      score && String(score.dataType).toUpperCase().includes("BIGINT"),
      `Expected 'score' to keep its BIGINT type, got: ${JSON.stringify(score)}`
    );
  });

  await step("delete a column", async () => {
    if (!created) {
      console.log("skipped: table was not created");
      return;
    }
    const res = await ctx.client.deleteInternalTableColumn(tableName, "score");
    assertStatus(res, 200, "deleteInternalTableColumn(score)");

    const after = await ctx.client.listInternalTableColumns(tableName);
    assertStatus(after, 200, "listInternalTableColumns after delete");
    const names = after.body.map((c) => c.name || c.columnName);
    assert(!names.includes("score"), `Column 'score' still present after deletion: ${names.join(", ")}`);
    assertIncludes(names, "segment", "remaining columns");
  });

  await step("delete the table and confirm it is gone", async () => {
    if (!created) {
      console.log("skipped: table was not created");
      return;
    }
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
