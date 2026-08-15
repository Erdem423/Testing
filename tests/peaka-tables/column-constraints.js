const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");

/**
 * What happens to isUnique, isNotNull and defaultValue on a Peaka Table column.
 *
 * THE ANSWER IS NOT "THEY ARE NOT ENFORCED" - it is narrower and worse.
 * Measured 2026-08-11: two of the three are silently DISCARDED AT CREATION.
 * The column is created with 200, and reading it straight back shows:
 *
 *   sent isUnique: true       -> stored isUnique: false
 *   sent isNotNull: true      -> stored isNotNull: false
 *   sent defaultValue: "..."  -> stored "...", and APPLIED on import
 *
 * So the enforcement question never even arises for the two flags: the
 * constraint does not exist to be enforced. This is a WRITE THAT SILENTLY DOES
 * NOT TAKE, the same shape as FINDINGS 12 (BI Table's displayName), and it is
 * a defect independent of what enforcement semantics Peaka intends - a field
 * documented as settable must round-trip.
 *
 * WHAT THE OFFICIAL DOCS SAY, checked before writing any assertion here:
 * https://docs.peaka.com/api-reference/data--internal-tables/add-column
 * describes the fields only as "The not null flag for the column", "The unique
 * flag for the column" and "The default value of the column". It never states
 * whether they are enforced. That is why this scenario deliberately asserts
 * the ROUND TRIP rather than enforcement - the docs make no enforcement
 * promise to hold Peaka to, but they plainly present these as settable
 * properties, and two of them are not.
 *
 * WHY A CUSTOMER HITS THIS. Marking an id or email column unique is ordinary
 * data modelling, and the API offers isUnique as a first-class field, so
 * setting it is the obvious thing to do. The call returns 200. Nobody
 * re-reads the column to check the flag survived. They then import a CSV
 * merged from two systems - the single most common source of duplicate
 * emails - and duplicates land silently. Because import appends and no
 * row-level DELETE exists (FINDINGS 20 and 11), those duplicates cannot be
 * removed afterwards without destroying the whole table.
 *
 * defaultValue IS the working one, and is asserted as such: a row imported
 * without that column comes back carrying the default, not NULL. Worth
 * pinning precisely BECAUSE its two neighbours are broken - it would be easy
 * to assume the whole feature is dead and stop using the part that works.
 */
const TABLE_NAME = "e2e_auto_pt_constraints";

const DEFAULT_VALUE = "THE_DEFAULT";

const col = (name, extra = {}) => ({
  name,
  dataType: "VARCHAR",
  displayName: name,
  defaultValue: null,
  isNotNull: false,
  isUnique: false,
  ...extra,
});

const HEADER = ["uniq", "notnull", "withdef"];

async function runPtConstraints(ctx) {
  const qualified = `"peaka"."table"."${TABLE_NAME}"`;

  function importRows(header, rows) {
    return ctx.client.createTableImport(TABLE_NAME, {
      file: rowsToCsv(header, rows),
      mappings: header.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
  }

  async function selectAll() {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT uniq, notnull, withdef FROM ${qualified}` },
      "SIMPLE"
    );
    assertStatusIn(res, [200], "SELECT");
    return res.body.data;
  }

  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table declaring a unique a not-null and a defaulted column", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, [
      col("uniq", { isUnique: true }),
      col("notnull", { isNotNull: true }),
      col("withdef", { defaultValue: DEFAULT_VALUE }),
    ]);
    // The request is ACCEPTED - that is precisely the problem, and the next
    // step is what shows why.
    assertStatusIn(colRes, [200], "addInternalTableColumns with constraints");
  });

  // THE HEADLINE.
  await step("the unique and not-null flags are silently discarded while defaultValue survives", async () => {
    const res = await ctx.client.listInternalTableColumns(TABLE_NAME);
    assertStatusIn(res, [200], "listInternalTableColumns");
    const byName = Object.fromEntries((res.body || []).map((c) => [c.name, c]));

    assert(byName.uniq && byName.notnull && byName.withdef, `Declared columns missing: ${JSON.stringify(Object.keys(byName))}`);

    // assert() rather than assertEqual(): these explanations are too long to
    // read well inside assertEqual's "Expected <label> to equal X" wrapper.
    assert(
      byName.uniq.isUnique === false,
      `A column created with isUnique:true reads back isUnique:${JSON.stringify(byName.uniq.isUnique)}. ` +
        `Expected false - the flag is accepted with 200 and silently dropped, so the constraint never ` +
        `exists. If this now reads true, Peaka has started honouring it: that is a FIX, and this scenario ` +
        `should be rewritten to assert enforcement instead of documenting the gap.`
    );
    assert(
      byName.notnull.isNotNull === false,
      `A column created with isNotNull:true reads back isNotNull:${JSON.stringify(byName.notnull.isNotNull)}. ` +
        `Expected false - the same silent drop as isUnique.`
    );

    // The control, and it carries real weight: without it, "the API ignores
    // this whole part of the column body" would explain the two above just as
    // well as a targeted bug.
    assert(
      byName.withdef.defaultValue === DEFAULT_VALUE,
      `defaultValue reads back as ${JSON.stringify(byName.withdef.defaultValue)}, expected ` +
        `${JSON.stringify(DEFAULT_VALUE)}. This is the control: defaultValue DOES round-trip, which is ` +
        `what makes the other two a targeted defect rather than the column body being ignored wholesale.`
    );

    console.log(
      `  FINDING: isUnique true->${byName.uniq.isUnique}, isNotNull true->${byName.notnull.isNotNull}, ` +
        `defaultValue ${JSON.stringify(DEFAULT_VALUE)}->${JSON.stringify(byName.withdef.defaultValue)}`
    );
  });

  await step("duplicate values import cleanly into the column declared unique", async () => {
    const res = await importRows(HEADER, [
      { uniq: "SAME", notnull: "x", withdef: "y" },
      { uniq: "SAME", notnull: "x", withdef: "y" },
    ]);
    assertStatusIn(res, [200], "createTableImport with a duplicated unique value");
    assertEqual(res.body.result.processed, 2, "rows processed");

    const rows = await selectAll();
    const duplicates = rows.filter((r) => r.uniq === "SAME").length;
    assert(
      duplicates === 2,
      `Expected both rows carrying the duplicated 'unique' value to land, got ${duplicates}. That follows ` +
        `directly from the flag never having been stored. For a caller this is the dangerous half: they ` +
        `declared uniqueness, got a 200, and never re-read the column - so duplicates accumulate silently, ` +
        `and FINDINGS 20 means they cannot be deleted afterwards.`
    );
  });

  await step("an empty value imports cleanly into the column declared not-null", async () => {
    const res = await importRows(HEADER, [{ uniq: "OTHER", notnull: "", withdef: "z" }]);
    assertStatusIn(res, [200], "createTableImport with an empty not-null value");

    const rows = await selectAll();
    const row = rows.find((r) => r.uniq === "OTHER");
    assert(row, "the row with an empty not-null value did not land at all");
    assertEqual(row.notnull, null, "the empty value stored in the column declared not-null (it becomes NULL)");
  });

  // THE PART THAT WORKS, asserted so it is not lost among the two that do not.
  await step("a defaulted column is filled in when the import omits it entirely", async () => {
    const res = await importRows(["uniq", "notnull"], [{ uniq: "THIRD", notnull: "q" }]);
    assertStatusIn(res, [200], "createTableImport omitting the defaulted column");

    const rows = await selectAll();
    const row = rows.find((r) => r.uniq === "THIRD");
    assert(row, "the row imported without the defaulted column is missing");
    assertEqual(
      row.withdef,
      DEFAULT_VALUE,
      `the defaulted column on a row whose import omitted it. defaultValue genuinely works end to end - ` +
        `stored at creation and applied at import`
    );
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

module.exports = { runPtConstraints };
