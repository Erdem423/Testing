const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * The sample endpoint - what getTableSample actually returns.
 *
 * FIXED A CLIENT BUG TO EVEN MEASURE THIS. `getTableSample()` calls
 * `_request` like every other method, which always tries `res.json()` - but
 * this endpoint returns `Content-Type: text/csv`, so that throws and the
 * caller silently gets `body: null`, no matter what the table actually
 * contains. Verified through this exact method before the fix: null, null,
 * null, in every one of four cases. `_request` gained an opt-in `raw: true`
 * mode (res.text() instead of res.json()) and `getTableSample` now uses it -
 * additive, no other caller touched.
 *
 * READ THE SPEC BEFORE READING THE OBSERVATIONS. Its PT-13 expects 2xx +
 * text/csv, a header carrying the table's column names, AT LEAST ONE EXAMPLE
 * data row ("en az 1 ornek veri satiri"), and that the returned file is
 * ACCEPTED when handed back to import as a template - it even suggests
 * downloading the sample and importing it as-is as further validation.
 *
 * That settles what the endpoint is FOR: a template, not a preview of real
 * rows. Measured against those criteria Peaka passes every one, round trip
 * included (200, COMPLETED, processed 5). So this scenario pins WORKING
 * behaviour, with one narrow deviation - see the end of this comment.
 *
 * WHAT IT ACTUALLY RETURNS, verified 2026-08-10 through the fixed method:
 *
 *   - A NONEXISTENT table: 200, body is five blank lines ("\n\n\n\n\n").
 *   - A real table: 200, header is "text,<real column names in order>" - an
 *     unexplained extra "text" column prepended, but the REAL column names
 *     do appear. Always exactly 5 data rows, regardless of the table's real
 *     row count (checked at 0 rows and after importing 2).
 *   - Every VARCHAR-typed column's value is literally "sample text". Every
 *     BIGINT-typed column's value is a random integer. The generator is
 *     TYPE-AWARE: it keys on column names and types, not on content.
 *   - Real imported values (alice/30-style) never appear, before or after
 *     import, confirmed here with a deliberately unmistakable value. That is
 *     CORRECT per the spec, which asked for example rows - it is asserted so
 *     the endpoint cannot start leaking real table contents unnoticed.
 *
 * THE ONE REAL DEVIATION is narrow: the header carries a leading "text"
 * column the caller never declared. Peaka adds "text" to every internal
 * table itself, so it is a genuine column - but a template handing back a
 * column the user did not create invites them to fill it in blind.
 *
 * WORTH KNOWING, though not a spec violation: because the generator emits
 * TYPE-VALID values and import validates strictly BY TYPE (FINDINGS 18),
 * the spec's own suggested round trip sails through and appends 5 rows of
 * "sample text". Harmless in a test - the spec's cleanup is a table delete,
 * which really does purge (FINDINGS 21) - but a user running the obvious
 * template workflow cannot remove those rows afterwards (FINDINGS 20).
 */
const TABLE_NAME = "e2e_auto_pt_sample";

const COLUMNS = [
  { name: "name", dataType: "VARCHAR", displayName: "name", isNotNull: false, isUnique: false },
  { name: "age", dataType: "BIGINT", displayName: "age", isNotNull: false, isUnique: false },
];

const UNMISTAKABLE_NAME = "zzz_real_data_marker_unmistakable";
const UNMISTAKABLE_AGE = "918273645";

async function runPtSample(ctx) {
  const qualified = `"peaka"."table"."${TABLE_NAME}"`;

  async function countRows() {
    const res = await ctx.client.executeQuery({ statement: `SELECT COUNT(*) AS cnt FROM ${qualified}` }, "SIMPLE");
    assertStatusIn(res, [200], "COUNT(*)");
    return Number(res.body.data[0].cnt);
  }

  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("the sample endpoint on a nonexistent table returns five blank lines, not an error", async () => {
    const res = await ctx.client.getTableSample(TABLE_NAME);
    assertStatusIn(res, [200], "getTableSample (nonexistent table)");
    assertEqual(res.body, "\n\n\n\n\n", "sample body for a nonexistent table");
  });

  await step("create the table with a VARCHAR and a BIGINT column", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, COLUMNS);
    assertStatusIn(colRes, [200], "addInternalTableColumns");
  });

  await step("the header names the real columns behind one unexplained leading 'text' column", async () => {
    const res = await ctx.client.getTableSample(TABLE_NAME);
    assertStatusIn(res, [200], "getTableSample (empty real table)");
    const lines = String(res.body).split("\n");
    // Compared as a SET, not a sequence. Measured across consecutive runs of
    // this exact scenario, Peaka returned "text,name,age" once and
    // "text,age,name" the next - the column order genuinely varies between
    // calls, and nothing documents an order to rely on. Asserting the literal
    // string made this fail intermittently for a reason that says nothing
    // about the endpoint's actual behaviour. What matters is WHICH columns
    // appear: the real ones, behind one unexplained leading 'text'.
    assertEqual(
      lines[0].split(",").sort().join(","),
      ["text", ...COLUMNS.map((c) => c.name)].sort().join(","),
      "sample header columns (order-independent)"
    );
    assertEqual(lines.length, 6, "line count: 1 header + 5 canned rows, regardless of the table holding 0 real rows");
  });

  await step("values are type-aware but never real: VARCHAR gets 'sample text', BIGINT gets a random int", async () => {
    const importRes = await ctx.client.createTableImport(TABLE_NAME, {
      file: `name,age\n${UNMISTAKABLE_NAME},${UNMISTAKABLE_AGE}\n`,
      mappings: [
        { name: "name", csvColumnName: "name" },
        { name: "age", csvColumnName: "age" },
      ],
      containsHeader: true,
    });
    assertStatusIn(importRes, [200], "createTableImport (unmistakable marker row)");

    const res = await ctx.client.getTableSample(TABLE_NAME);
    assertStatusIn(res, [200], "getTableSample (after importing real data)");
    const body = String(res.body);

    assert(
      !body.includes(UNMISTAKABLE_NAME) && !body.includes(UNMISTAKABLE_AGE),
      `The sample body contains the real imported marker value - it is supposed to be entirely synthetic. Body: ${body}`
    );

    // Columns are located BY NAME from the header rather than by fixed
    // position - the order varies between calls (see the header step above),
    // and with hardcoded indices a flipped order silently checked 'age'
    // against the VARCHAR rule and 'name' against the BIGINT one. That would
    // fail for a reason that reads like a type bug and is not one.
    const header = body.split("\n")[0].split(",");
    const col = (name) => {
      const i = header.indexOf(name);
      assert(i !== -1, `sample header is missing the '${name}' column: ${header.join(",")}`);
      return i;
    };
    const iText = col("text");
    const iName = col("name");
    const iAge = col("age");

    const dataLines = body.split("\n").slice(1);
    assertEqual(dataLines.length, 5, "canned data rows");
    for (const line of dataLines) {
      const cells = line.split(",");
      assertEqual(cells[iText], '"sample text"', `leading 'text' column cell: ${line}`);
      assertEqual(cells[iName], '"sample text"', `VARCHAR 'name' column cell: ${line}`);
      assert(/^\d+$/.test(cells[iAge]), `BIGINT 'age' column cell should be a bare integer, got: ${JSON.stringify(cells[iAge])} (line: ${line})`);
    }
    console.log(`  FINDING confirmed: canned, type-aware sample, real data never appears - ${JSON.stringify(dataLines)}`);
  });

  // THE SPEC'S OWN SUGGESTED VALIDATION: "sample'i indirip aynen import et" -
  // download the sample and import it as-is. It is expected to be accepted,
  // and it is. Closing this edge is the whole point of a template endpoint:
  // a template that its own importer rejects would be useless.
  await step("the sample output is accepted when imported back as a template", async () => {
    const sample = await ctx.client.getTableSample(TABLE_NAME);
    assertStatusIn(sample, [200], "getTableSample (for the round trip)");

    const before = await countRows();
    const header = String(sample.body).split("\n")[0].split(",");
    const res = await ctx.client.createTableImport(TABLE_NAME, {
      file: String(sample.body),
      mappings: header.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
    assertStatusIn(
      res,
      [200],
      "importing the sample back as a template (the spec expects this to be accepted)"
    );
    assertEqual(res.body.result.processed, 5, "rows processed from the sample template");
    assertEqual(await countRows(), before + 5, "rows after importing the sample back in");
  });

  // The consequence, which the spec does not anticipate because it assumes
  // row-level editing exists. Import APPENDS (FINDINGS 20) and no row DELETE
  // exists (FINDINGS 11), so the 5 placeholder rows a user just uploaded
  // cannot be removed - only dropping the whole table clears them.
  await step("the round trip leaves placeholder rows that cannot be removed row by row", async () => {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT name FROM ${qualified} WHERE name = 'sample text'` },
      "SIMPLE"
    );
    assertStatusIn(res, [200], "SELECT the placeholder rows");
    assertEqual(
      res.body.data.length,
      5,
      `placeholder rows now sitting in the table. A customer following the obvious template workflow - ` +
        `download the sample, fill it in, upload - keeps these unless they notice and delete them first, ` +
        `and no API call can remove them afterwards short of dropping the entire table`
    );
    console.log("  5 'sample text' placeholder rows are now permanent until the table is dropped");
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

module.exports = { runPtSample };
