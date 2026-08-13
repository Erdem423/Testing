const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError } = require("../../helpers/serverError");
const { rowsToCsv } = require("../../helpers/csvFixtures");

/**
 * What CSV import does with a value that does not fit its declared column type.
 *
 * WHY THIS EXISTS, and why the answer was a surprise. FINDINGS #10 records that
 * a bad MAPPING - pointing an import at a CSV header that does not exist -
 * returns 200, reports "processed", and silently writes NULL. The obvious
 * prediction was that the value-parsing path in the same endpoint would be
 * equally lax, which would be strictly worse: a mapping typo is a caller error
 * in metadata, but a bad VALUE would be real data discarded on a request that
 * looks correct and reports success.
 *
 * MEASURED 2026-08-10, AND THE PREDICTION WAS WRONG. Value parsing is strict,
 * atomic, and has the best error messages in this entire API:
 *
 *   "abc"                        -> 400  invalid input syntax for type bigint: "abc"
 *   "2024-13-45"                 -> 400  date/time field value out of range
 *   "maybe"                      -> 400  invalid input syntax for type boolean: "maybe"
 *   25-digit number into BIGINT  -> 400  value "999..." is out of range for type bigint
 *   "not-a-uuid-at-all"          -> 400  invalid input syntax for type uuid
 *
 * Each message names the offending value, and the batch form also names the
 * CSV line number and column. Every rejection is ATOMIC - COUNT(*) is 0
 * afterwards, so not even the valid rows preceding the bad one are written.
 *
 * SO THIS SCENARIO PINS GOOD BEHAVIOUR, which is the unusual thing about it.
 * Most of this folder documents deviations; this asserts a guarantee, so that
 * if Peaka ever relaxes value parsing to match its lax mapping handling - the
 * plausible direction of drift, since they share an endpoint - the change is
 * caught rather than discovered by a user with corrupted data.
 *
 * The contrast with FINDINGS #10 stands on its own and is worth keeping in
 * mind when reading both: the SAME endpoint validates values rigorously and
 * mappings not at all.
 */
const TABLE_NAME = "e2e_auto_pt_type_coercion";

// Deliberately includes UUID - probed as creatable, and a type whose parser is
// easy to get wrong.
const COLUMNS = [
  { name: "case_name", dataType: "VARCHAR", displayName: "case_name", isNotNull: false, isUnique: false },
  { name: "n", dataType: "BIGINT", displayName: "n", isNotNull: false, isUnique: false },
  { name: "d", dataType: "DATE", displayName: "d", isNotNull: false, isUnique: false },
  { name: "b", dataType: "BOOLEAN", displayName: "b", isNotNull: false, isUnique: false },
  { name: "huge", dataType: "BIGINT", displayName: "huge", isNotNull: false, isUnique: false },
  { name: "u", dataType: "UUID", displayName: "u", isNotNull: false, isUnique: false },
];

const HEADER = ["case_name", "n", "d", "b", "huge", "u"];
const VALID = {
  n: "42",
  d: "2024-01-15",
  b: "true",
  huge: "123",
  u: "6f1e7b3a-2c4d-4e5f-8a9b-0c1d2e3f4a5b",
};

// One bad value per case, everything else valid - so a rejection is
// attributable to that one column and nothing else.
const BAD_CASES = [
  { name: "bad_bigint", column: "n", value: "abc", why: "not a number at all" },
  { name: "bad_date", column: "d", value: "2024-13-45", why: "month 13, day 45" },
  { name: "bad_boolean", column: "b", value: "maybe", why: "not true/false" },
  { name: "overflow_bigint", column: "huge", value: "9999999999999999999999999", why: "25 digits, past int64" },
  { name: "bad_uuid", column: "u", value: "not-a-uuid-at-all", why: "malformed UUID" },
];

async function runPtTypeCoercion(ctx) {
  const qualified = () => `"peaka"."table"."${TABLE_NAME}"`;

  async function countRows() {
    const res = await ctx.client.executeQuery({ statement: `SELECT COUNT(*) AS cnt FROM ${qualified()}` }, "SIMPLE");
    assertStatusIn(res, [200], "COUNT(*)");
    return Number(res.body.data[0].cnt);
  }

  /** A CSV holding one valid control row followed by one deliberately bad row. */
  function csvFor(badCase) {
    return rowsToCsv(HEADER, [
      { case_name: "control", ...VALID },
      { case_name: badCase.name, ...VALID, [badCase.column]: badCase.value },
    ]);
  }

  function importCsv(file) {
    return ctx.client.createTableImport(TABLE_NAME, {
      file,
      mappings: HEADER.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
  }

  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table with six typed columns, including UUID", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, COLUMNS);
    assertStatusIn(colRes, [200], "addInternalTableColumns (incl. UUID)");
  });

  // THE HEADLINE. Each bad value gets its OWN import, deliberately: a single
  // CSV carrying all five stops at the first one (the error names the line
  // number), so a batch would only ever prove the first case and say nothing
  // about the other four.
  await step("an invalid value for a declared type is rejected, never silently stored", async () => {
    for (const badCase of BAD_CASES) {
      const res = await importCsv(csvFor(badCase));

      // A 5xx would mean a crash rather than validation - a different, worse
      // outcome, and the one thing that must never happen here.
      assertNoServerError(res, `import with ${badCase.name}`);
      assert(
        res.status >= 400 && res.status < 500,
        `Expected a 4xx rejecting ${badCase.column}=${JSON.stringify(badCase.value)} (${badCase.why}), ` +
          `got ${res.status}. If this now succeeds, Peaka has started ACCEPTING values that do not fit ` +
          `their declared type - check what it stored, because silently coercing or NULLing them would ` +
          `be data loss on a request that reports success (compare FINDINGS #10, where a bad MAPPING ` +
          `does exactly that).`
      );

      // The message quality is genuinely good here and worth pinning: it names
      // the offending value, which is what makes the error actionable. The
      // exact wording is Peaka's to change, so only the value is asserted.
      const message = String((res.body && res.body.message) || "");
      assert(
        message.includes(badCase.value),
        `The rejection for ${badCase.name} does not name the offending value ${JSON.stringify(badCase.value)}. ` +
          `Got: ${message.slice(0, 200)}`
      );
      console.log(`  ${badCase.name.padEnd(16)} -> ${res.status}  ${message.split("\n")[0].slice(0, 90)}`);
    }
  });

  // ATOMICITY. Each CSV above had a VALID control row before the bad one. If
  // the import were row-by-row, that row would have landed and the table would
  // be non-empty - a partial import is exactly the "yarim import kabul edilmez"
  // case the source doc calls out.
  await step("a rejected import writes nothing, not even the valid rows before the bad one", async () => {
    const count = await countRows();
    assertEqual(count, 0, "rows in the table after five rejected imports, each with a valid row first");
    console.log("  five rejected imports, each containing one valid row -> table is still empty");
  });

  // THE CONTROL, and it carries real weight: without it, every rejection above
  // could equally be explained by "this table cannot be imported into at all".
  await step("the same import shape succeeds when every value is valid", async () => {
    const res = await importCsv(
      rowsToCsv(HEADER, [
        { case_name: "control", ...VALID },
        { case_name: "second", ...VALID, n: "43" },
      ])
    );
    assertStatusIn(res, [200], "createTableImport (all values valid)");
    assertEqual(res.body.status, "COMPLETED", "import job status");
    assertEqual(res.body.result.processed, 2, "rows processed");
    assertEqual(await countRows(), 2, "rows in the table after a valid import");

    // And the valid values round-trip rather than merely being accepted.
    const sel = await ctx.client.executeQuery(
      { statement: `SELECT case_name, n, d, b, u FROM ${qualified()} WHERE case_name = 'control'` },
      "SIMPLE"
    );
    assertStatusIn(sel, [200], "SELECT the control row");
    const row = sel.body.data[0];
    assert(row, "The control row is missing after a successful import");
    assertEqual(String(row.n), VALID.n, "BIGINT round-trip");
    assertEqual(String(row.u), VALID.u, "UUID round-trip");
    assert(
      String(row.d).startsWith("2024-01-15"),
      `DATE round-trip: expected the value to start with 2024-01-15, got ${JSON.stringify(row.d)}`
    );
    console.log(`  valid import accepted: ${JSON.stringify(row)}`);
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

module.exports = { runPtTypeCoercion };
