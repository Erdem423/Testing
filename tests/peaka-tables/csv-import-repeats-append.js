const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");

/**
 * What a SECOND successful CSV import does to a table that already holds rows.
 *
 * WHY THIS MATTERS MORE THAN IT SOUNDS. CSV import is the only write path that
 * exists: SqlExec rejects INSERT/UPDATE/DELETE outright (FINDINGS 9) and no
 * row-level REST endpoint exists under any of the six shapes probed for it
 * (FINDINGS 11). So "how do I change data in a Peaka Table?" has exactly one
 * candidate answer - re-import - and nobody had ever measured what that does.
 * Every other scenario in this folder imports into a FRESH table exactly once.
 *
 * MEASURED 2026-08-11: import APPENDS, unconditionally.
 *
 *   import 3 rows into an empty table   -> processed 3, COUNT(*) = 3
 *   import the BYTE-IDENTICAL CSV again -> processed 3, COUNT(*) = 6
 *   import a different 2-row CSV        -> processed 2, COUNT(*) = 8
 *
 * There is no replace mode and no deduplication - not even for a byte-identical
 * file. The duplicate rows carry DIFFERENT _id values, so they are genuinely
 * new rows rather than the same row read twice.
 *
 * `result.processed` counts THIS import's rows, never the table total. A caller
 * reading it as "how many rows the table now has" is correct exactly once, and
 * wrong from the second import onward.
 *
 * THE CONSEQUENCE IS THE REAL FINDING, and it is worth stating plainly:
 * append-only + no UPDATE + no DELETE + no dedup means a Peaka Table can only
 * ever GROW. A row imported by mistake cannot be corrected or removed through
 * any API call in this client - the only recovery is dropping the entire table
 * and rebuilding it (which the sibling delete-purge scenario shows really does
 * work). That answers the question FINDINGS 9 and 11 raise but leave hanging.
 *
 * Not re-asserted here: that UPDATE/DELETE are rejected. The no-row-level-edit
 * scenario already pins that, and duplicating it would couple the two files.
 */
const TABLE_NAME = "e2e_auto_pt_repeat_import";

const COLUMNS = [
  { name: "name", dataType: "VARCHAR", displayName: "name", isNotNull: false, isUnique: false },
  { name: "n", dataType: "BIGINT", displayName: "n", isNotNull: false, isUnique: false },
];

const HEADER = ["name", "n"];
const FIRST_ROWS = [
  { name: "alice", n: "1" },
  { name: "bob", n: "2" },
  { name: "carol", n: "3" },
];
const SECOND_ROWS = [
  { name: "dave", n: "4" },
  { name: "erin", n: "5" },
];

async function runPtRepeatImport(ctx) {
  const qualified = `"peaka"."table"."${TABLE_NAME}"`;

  async function countRows() {
    const res = await ctx.client.executeQuery({ statement: `SELECT COUNT(*) AS cnt FROM ${qualified}` }, "SIMPLE");
    assertStatusIn(res, [200], "COUNT(*)");
    return Number(res.body.data[0].cnt);
  }

  /**
   * Rows with _id, ordered deterministically.
   *
   * ORDER BY includes _id as a tiebreaker on purpose: with duplicate `n`
   * values, ordering by `n` alone came back in a DIFFERENT order between two
   * calls during probing. Nothing below may depend on array position anyway -
   * the assertions count occurrences per name - but an unstable order makes
   * the failure output confusing to read.
   */
  async function fetchRows() {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT _id, name, n FROM ${qualified} ORDER BY n, _id` },
      "SIMPLE"
    );
    assertStatusIn(res, [200], "SELECT rows");
    return res.body.data;
  }

  function importRows(rows) {
    return ctx.client.createTableImport(TABLE_NAME, {
      file: rowsToCsv(HEADER, rows),
      mappings: HEADER.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
  }

  function occurrencesOf(rows, name) {
    return rows.filter((r) => r.name === name);
  }

  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table and import three rows", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, COLUMNS);
    assertStatusIn(colRes, [200], "addInternalTableColumns");

    const importRes = await importRows(FIRST_ROWS);
    assertStatusIn(importRes, [200], "createTableImport (first)");
    assertEqual(importRes.body.result.processed, 3, "rows processed by the first import");
    assertEqual(await countRows(), 3, "rows in the table after the first import");
  });

  // THE HEADLINE.
  await step("importing the identical CSV again appends and does not deduplicate", async () => {
    const res = await importRows(FIRST_ROWS);
    assertStatusIn(res, [200], "createTableImport (identical file, second time)");

    // processed counts THIS file's rows, not the table total - the distinction
    // a caller is most likely to get wrong.
    assertEqual(res.body.result.processed, 3, "rows processed by the second import (this file's rows, not the total)");

    // assert() rather than assertEqual() deliberately: the explanation below is
    // too long to read well inside assertEqual's "Expected <label> to equal X"
    // wrapper.
    const count = await countRows();
    assert(
      count === 6,
      `Expected 6 rows after importing the same 3-row file twice, got ${count}. ` +
        `If this is 3, Peaka has switched CSV import from APPEND to REPLACE semantics - a significant ` +
        `behaviour change, and arguably a fix, since it would give Peaka Tables their first real update ` +
        `mechanism. Update this scenario rather than assuming a bug.`
    );

    const rows = await fetchRows();
    for (const original of FIRST_ROWS) {
      const copies = occurrencesOf(rows, original.name);
      assertEqual(copies.length, 2, `copies of '${original.name}' after importing the same file twice`);

      // The two copies must be genuinely separate rows. Identical _ids would
      // mean we were reading one row twice rather than seeing a real duplicate.
      assert(
        copies[0]._id !== copies[1]._id,
        `Both copies of '${original.name}' share the same _id (${copies[0]._id}) - they are not ` +
          `distinct rows, so this is not really an append`
      );
    }
    console.log(`  FINDING confirmed: byte-identical re-import appended 3 more rows, no dedup - COUNT(*) = ${count}`);
  });

  // Rules out "replaces only when the content differs", which the step above
  // cannot distinguish on its own.
  await step("a second different CSV also appends rather than replacing", async () => {
    const res = await importRows(SECOND_ROWS);
    assertStatusIn(res, [200], "createTableImport (different file)");
    assertEqual(res.body.result.processed, 2, "rows processed by the third import");
    assertEqual(await countRows(), 8, "rows after importing a different file into a non-empty table");

    const rows = await fetchRows();
    for (const original of FIRST_ROWS) {
      assertEqual(occurrencesOf(rows, original.name).length, 2, `copies of '${original.name}' survived the third import`);
    }
    for (const added of SECOND_ROWS) {
      assertEqual(occurrencesOf(rows, added.name).length, 1, `copies of the newly added '${added.name}'`);
    }
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

module.exports = { runPtRepeatImport };
