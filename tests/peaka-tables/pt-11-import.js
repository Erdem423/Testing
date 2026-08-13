const { assert, assertEqual, assertApprox, assertStatus } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");

/**
 * PT-11: CSV import - happy path.
 *
 * The doc's own literal import test, and this suite's first real write
 * path: SqlExec is SELECT-only (see helpers/peakaClient.js's executeQuery
 * comment), and CSV import via PtImport is the only way to put data into a
 * Peaka Table. This scenario proves that path end to end before anything
 * downstream (PT-07/09/10, CMP-03) builds seed data on top of it.
 *
 * Fixed deterministic name per the doc's rule 2 - no runTag() suffix, so a
 * leftover from a half-finished prior run is findable by this exact name.
 */
const TABLE_NAME = "e2e_auto_pt_import";

const COLUMNS = [
  { name: "name", dataType: "VARCHAR", displayName: "name", isNotNull: false, isUnique: false },
  { name: "age", dataType: "BIGINT", displayName: "age", isNotNull: false, isUnique: false },
  { name: "score", dataType: "DECIMAL", displayName: "score", isNotNull: false, isUnique: false },
];

// Deterministic, hand-built - no Math.random - so "sampled rows match" can
// assert exact values rather than just checking something round-tripped.
const NAMES = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy"];
const ROWS = NAMES.map((name, i) => ({
  name,
  age: String(20 + i * 3),
  score: ((i + 1) * 12.5).toFixed(2),
}));

async function runPtImport(ctx) {
  await step("clean up any leftover table from a previous run", async () => {
    // Best-effort, not asserted - there may be nothing to delete.
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table with name/age/score columns", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatus(createRes, 200, "createInternalTable");
    assertEqual(createRes.body.catalogName, "peaka", "catalogName");
    assertEqual(createRes.body.schemaName, "table", "schemaName");
    assertEqual(createRes.body.tableName, TABLE_NAME, "tableName");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, COLUMNS);
    assertStatus(colRes, 200, "addInternalTableColumns");
  });

  await step("import a 10-row CSV", async () => {
    const csvString = rowsToCsv(["name", "age", "score"], ROWS);
    const importRes = await ctx.client.createTableImport(TABLE_NAME, {
      file: csvString,
      mappings: [
        { name: "name", csvColumnName: "name" },
        { name: "age", csvColumnName: "age" },
        { name: "score", csvColumnName: "score" },
      ],
      containsHeader: true,
    });
    assertStatus(importRes, 200, "createTableImport");
    assertEqual(importRes.body.status, "COMPLETED", "import job status");
    assert(importRes.body.result, `Import response had no 'result' field: ${JSON.stringify(importRes.body)}`);
    assertEqual(importRes.body.result.processed, ROWS.length, "rows processed, per the import job's own response");
    ctx.lastImportResult = importRes.body;
  });

  await step("row count matches the import job and a real COUNT(*)", async () => {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."table"."${TABLE_NAME}"` },
      "SIMPLE"
    );
    assertStatus(res, 200, "COUNT(*)");
    const count = Number(res.body.data[0].cnt);
    assertEqual(count, ROWS.length, "COUNT(*) after import");
    assertEqual(count, ctx.lastImportResult.result.processed, "COUNT(*) vs the import job's own processed count");
  });

  await step("sampled rows match the imported values", async () => {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT name, age, score FROM "peaka"."table"."${TABLE_NAME}" ORDER BY name` },
      "SIMPLE"
    );
    assertStatus(res, 200, "SELECT name, age, score");
    const byName = {};
    for (const row of res.body.data) byName[row.name] = row;

    // "randomly selected 2 rows" per the doc - fixed here for reproducible
    // failures rather than actually randomizing which two.
    for (const expected of [ROWS[2], ROWS[7]]) {
      const actual = byName[expected.name];
      assert(actual, `Row for '${expected.name}' is missing from the imported table entirely`);
      assertEqual(String(actual.age), expected.age, `age for '${expected.name}'`);
      // DECIMAL round-trips zero-padded to 10 places ("12.50" -> in as
      // "12.5000000000") - verified 2026-08-06 - so compare numerically,
      // not as strings.
      assertApprox(Number(actual.score), Number(expected.score), 0.001, `score for '${expected.name}'`);
    }
  });

  await step("delete the table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatus(delRes, 200, "deleteInternalTable");
    const idx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const list = await ctx.client.listInternalTables();
    const stillPresent = (list.body || []).some((t) => t.tableName === TABLE_NAME);
    assert(!stillPresent, `'${TABLE_NAME}' still appears in listInternalTables() after delete`);
  });
}

module.exports = { runPtImport };
