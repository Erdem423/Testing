const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError } = require("../../helpers/serverError");

/**
 * A bad mapping silently writes NULL instead of failing - the doc's PT-12.
 *
 * The doc expects all four mapping mistakes below to be rejected (4xx) and
 * the table to end up with zero rows - "yarim import kabul edilmez". Live
 * behavior, verified 2026-08-06, is NOT that for one of them:
 *
 *   1. mapping targets a column that doesn't exist   -> 400 (rejected)
 *   2. mapping references a CSV header that doesn't
 *      exist in the file                             -> 200, SUCCEEDS.
 *      The mapped column is silently written as NULL - no error at all.
 *      A typo in a mapping's csvColumnName causes silent data loss, not
 *      a rejection.
 *   3. csvColumnName used when containsHeader:false
 *      (csvColumnIndex is required instead)          -> 400 (rejected)
 *   4. malformed JSON in the 'request' part           -> 400 (rejected)
 *
 * So this scenario asserts what's actually true rather than the doc's
 * unverified assumption: three genuine rejections, and one silent-success
 * case pinned as its own explicit step. If Peaka ever starts rejecting
 * case 2 properly, THIS step goes red and says so - that's deliberate.
 *
 * Also worth knowing, logged but not hard-asserted (the exact wording isn't
 * something to pin): case 1's rejection message is a raw backend SQL syntax
 * error ("syntax error at or near ')'"), and case 3's is an unrelated
 * MinIO storage error - neither names the actual mapping problem, which
 * the doc's own rule 5 asks for.
 */
const TABLE_NAME = "e2e_auto_pt_import_errors";

const COLUMNS = [
  { name: "name", dataType: "VARCHAR", displayName: "name", isNotNull: false, isUnique: false },
  { name: "age", dataType: "BIGINT", displayName: "age", isNotNull: false, isUnique: false },
  { name: "score", dataType: "DECIMAL", displayName: "score", isNotNull: false, isUnique: false },
];

const HEADERED_CSV = "name,age,score\nalice,30,10.5\nbob,40,20.5\n";
const HEADERLESS_CSV = "alice,30,10.5\nbob,40,20.5\n";

async function countRows(ctx) {
  const res = await ctx.client.executeQuery(
    { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."table"."${TABLE_NAME}"` },
    "SIMPLE"
  );
  assertStatusIn(res, [200], "COUNT(*)");
  return Number(res.body.data[0].cnt);
}

async function runPtImportErrors(ctx) {
  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table with name/age/score columns", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, COLUMNS);
    assertStatusIn(colRes, [200], "addInternalTableColumns");
  });

  await step("reject a mapping to a nonexistent target column", async () => {
    const res = await ctx.client.createTableImport(TABLE_NAME, {
      file: HEADERED_CSV,
      mappings: [{ name: "yok_boyle_kolon", csvColumnName: "name" }],
      containsHeader: true,
    });
    assert(
      res.status >= 400 && res.status < 500,
      `Expected a 4xx for a mapping to a nonexistent column, got ${res.status}: ${JSON.stringify(res.body)}`
    );
    assertNoServerError(res, "res", {
      message: `Got a 5xx, which the doc's rule 6 never allows: ${res.status}`,
    });
    console.log(`  (message quality, not asserted: ${JSON.stringify(res.body && res.body.message)})`);

    const count = await countRows(ctx);
    assertEqual(count, 0, "row count after a rejected import");
  });

  await step("silently accept a mapping to a nonexistent CSV header, writing NULL", async () => {
    const res = await ctx.client.createTableImport(TABLE_NAME, {
      file: HEADERED_CSV,
      mappings: [
        { name: "name", csvColumnName: "yok_boyle_baslik" }, // <- the typo
        { name: "age", csvColumnName: "age" },
        { name: "score", csvColumnName: "score" },
      ],
      containsHeader: true,
    });
    // NOT the doc's expected 4xx - this is the live-verified deviation this
    // scenario exists to pin. If this ever starts returning 4xx instead,
    // that's Peaka fixing the gap and this test SHOULD fail to say so.
    assert(
      res.status >= 200 && res.status < 300,
      `Expected this to still silently succeed (2xx) as measured - got ${res.status}. If Peaka started ` +
        `rejecting a mapping to a nonexistent CSV header, that's a real fix: update this scenario to assert ` +
        `4xx instead of documenting the gap.`
    );
    assert(res.body && res.body.result, `Import response had no 'result' field: ${JSON.stringify(res.body)}`);
    assertEqual(res.body.result.processed, 2, "rows processed despite the bad mapping");

    const sel = await ctx.client.executeQuery(
      { statement: `SELECT name, age, score FROM "peaka"."table"."${TABLE_NAME}" ORDER BY age` },
      "SIMPLE"
    );
    assertStatusIn(sel, [200], "SELECT after the silent-success import");
    for (const row of sel.body.data) {
      assert(
        row.name === null,
        `Expected 'name' to be NULL for a mapping that referenced a nonexistent CSV header - got ${JSON.stringify(
          row.name
        )}. Row: ${JSON.stringify(row)}`
      );
    }
    console.log(`  FINDING confirmed: 2 rows imported with name=NULL, no error raised - ${JSON.stringify(sel.body.data)}`);
    ctx.rowsAfterSilentSuccess = await countRows(ctx);
    assertEqual(ctx.rowsAfterSilentSuccess, 2, "row count after the silent-success import");
  });

  await step("reject csvColumnName when containsHeader is false", async () => {
    const res = await ctx.client.createTableImport(TABLE_NAME, {
      file: HEADERLESS_CSV,
      mappings: [{ name: "name", csvColumnName: "name" }], // csvColumnIndex required here instead
      containsHeader: false,
    });
    assert(
      res.status >= 400 && res.status < 500,
      `Expected a 4xx for csvColumnName without a header, got ${res.status}: ${JSON.stringify(res.body)}`
    );
    console.log(`  (message quality, not asserted: ${JSON.stringify(res.body && res.body.message)})`);

    const count = await countRows(ctx);
    assertEqual(count, ctx.rowsAfterSilentSuccess, "row count unchanged by this rejected import");
  });

  await step("reject malformed JSON in the request part", async () => {
    // Deliberately truncated JSON - createTableImport always sends valid
    // JSON, so this bypasses it via _request directly to send garbage.
    const fd = new FormData();
    fd.append("file", new Blob([HEADERED_CSV], { type: "text/csv" }), "import.csv");
    fd.append("request", '{"mappings":[{"name":"name"');
    const res = await ctx.client._request(
      "POST",
      `/data/projects/${ctx.projectId}/table/${TABLE_NAME}/import`,
      { formData: fd }
    );
    assert(
      res.status >= 400 && res.status < 500,
      `Expected a 4xx for malformed request JSON, got ${res.status}: ${JSON.stringify(res.body)}`
    );

    const count = await countRows(ctx);
    assertEqual(count, ctx.rowsAfterSilentSuccess, "row count unchanged by this rejected import");
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

module.exports = { runPtImportErrors };
