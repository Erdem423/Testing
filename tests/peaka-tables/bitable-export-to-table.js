const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { pollExport } = require("../../helpers/pollExport");
const { load } = require("../../helpers/preflight");

/**
 * Exporting a BI Table and importing it into a Peaka Table.
 *
 * THIS IS THE ONLY WAY OUT OF A BI TABLE, which is what makes it more than a
 * copy of the Peaka Table export round trip. That scenario exports a table and
 * imports the file straight back into the same kind. This one cannot: no import
 * route exists for the bitable path (FINDINGS 29), so the round trip has to
 * land somewhere else - and a Peaka Table is the only internal destination that
 * accepts writes at all.
 *
 * WHY A CUSTOMER NEEDS IT. Anyone who hits FINDINGS 29 - data readable in a BI
 * Table, no API way to change it - needs their rows somewhere editable. This is
 * that path, and as far as the Partner API is concerned it is the only one.
 *
 * MEASURED 2026-08-13 against a BI Table holding 8 Studio-entered rows:
 *
 *   createTableExport("1", "bitable", ...)  -> 202, then SUCCEEDED, rowCount 8
 *   downloaded file                          -> 9 lines: header + all 8 rows
 *   header  _id,_version,_created_time,_created_by,_last_modified_time,
 *           _last_modified_by,_session,_operation,text,date
 *
 * THE HEADER CARRIES _operation, the ninth system column that a Peaka Table
 * does not have. So a BI Table export is even less directly re-importable than
 * a Peaka Table export (FINDINGS 26): it has one more Peaka-owned column to
 * filter out of any mapping, and _operation would be meaningless in the
 * destination even if it were accepted.
 *
 * GATED on peakaTables.biTableWithData - rows arrive only through Studio.
 * ASYNC, so this shares the flakiness FINDINGS records for exports generally.
 */
const DEST_TABLE = "e2e_auto_bi_export_dst";

async function runBiTableExport(ctx) {
  const report = load();
  const pt = (report && report.peakaTables) || {};
  const biTable = pt.biTable;
  const expectedRows = pt.biTableRowCount;
  const userColumns = pt.biTableColumns || [];

  let exportedCsv = null;
  let exportedHeader = [];

  await step("the preflight found a BI Table holding rows", async () => {
    assert(biTable, `Preflight recorded no BI Table with rows: ${JSON.stringify(pt)}`);
    assert(userColumns.length > 0, `Preflight recorded no user columns on '${biTable}'`);
    console.log(`  exporting '${biTable}' (${expectedRows} rows, columns ${JSON.stringify(userColumns)})`);
  });

  await step("export the BI Table and poll until it succeeds", async () => {
    // catalogId "1" is the built-in `peaka` catalog; BI Tables live in its
    // `bitable` schema, the sibling of `table`.
    const res = await ctx.client.createTableExport("1", "bitable", biTable, { format: "CSV" });
    assertStatusIn(res, [200, 202], "createTableExport on a BI Table");
    assert(res.body && res.body.id, `Expected an export job id, got: ${JSON.stringify(res.body).slice(0, 200)}`);

    const final = await pollExport(ctx.client, res.body.id, { label: "BI Table export" });
    assertEqual(String(final.status).toUpperCase(), "SUCCEEDED", "final export status");
    assert(Array.isArray(final.files) && final.files.length > 0, `A succeeded export exposed no files: ${JSON.stringify(final).slice(0, 240)}`);
    assertEqual(Number(final.rowCount), expectedRows, "rowCount reported by the export job");

    const download = await fetch(final.files[0].url);
    assertEqual(download.status, 200, "HTTP status downloading the exported file");
    exportedCsv = await download.text();
    exportedHeader = exportedCsv.trim().split("\n")[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
  });

  await step("the exported file holds every row the BI Table reported", async () => {
    const lines = exportedCsv.trim().split("\n");
    assertEqual(
      lines.length - 1,
      expectedRows,
      `data rows in the downloaded file. The Stripe cap reaches that connector's export files (FINDINGS 1), ` +
        `so an internal-table export was a plausible place for a cap to reappear`
    );
    console.log(`  exported ${lines.length - 1} of ${expectedRows} rows`);
  });

  await step("the export carries _operation which a Peaka Table export does not", async () => {
    assert(
      exportedHeader.includes("_operation"),
      `The BI Table export is missing _operation. Header: ${JSON.stringify(exportedHeader)} - it is the ` +
        `column that distinguishes a BI Table from a Peaka Table, so an export without it would be ` +
        `indistinguishable from the other kind`
    );
    for (const col of userColumns) {
      assert(exportedHeader.includes(col), `The export is missing the user column '${col}'`);
    }
    console.log(`  export header: ${JSON.stringify(exportedHeader)}`);
  });

  // THE MIGRATION PATH.
  await step("the exported rows import into a Peaka Table", async () => {
    await ctx.client.deleteInternalTable(DEST_TABLE).catch(() => {});
    const createRes = await ctx.client.createInternalTable(DEST_TABLE);
    assertStatusIn(createRes, [200], "createInternalTable (destination)");
    ctx.createdInternalTableNames.push(DEST_TABLE);

    // ONLY ADD COLUMNS THE DESTINATION DOES NOT ALREADY HAVE. `text` is not a
    // user column at all - every internal table of either kind is created with
    // one, so it shows up in the BI Table's non-underscore columns while
    // already existing on the destination. Adding it blindly fails, and fails
    // spectacularly: a 400 carrying a raw PostgreSQL exception complete with
    // the internal schema name, the generated ALTER TABLE, the PL/pgSQL
    // function names and their arguments. That is the same shape of internal
    // leak as FINDINGS 28, just with an errorCode attached.
    //
    // Reading the destination's own columns rather than hardcoding "text"
    // keeps this working if Peaka ever adds another default column.
    const existing = await ctx.client.listInternalTableColumns(DEST_TABLE);
    assertStatusIn(existing, [200], "listInternalTableColumns (destination)");
    const alreadyThere = new Set((existing.body || []).map((c) => c.name));

    const toCreate = userColumns.filter((name) => !alreadyThere.has(name));
    if (toCreate.length > 0) {
      const colRes = await ctx.client.addInternalTableColumns(
        DEST_TABLE,
        toCreate.map((name) => ({
          name,
          dataType: "VARCHAR",
          displayName: name,
          defaultValue: null,
          isNotNull: false,
          isUnique: false,
        }))
      );
      assertStatusIn(colRes, [200], "addInternalTableColumns (destination)");
    }
    console.log(
      `  destination already had ${JSON.stringify([...alreadyThere].filter((c) => userColumns.includes(c)))}, ` +
        `created ${JSON.stringify(toCreate)}`
    );

    const mappable = exportedHeader.filter((h) => userColumns.includes(h));
    assertEqual(mappable.length, userColumns.length, "user columns found in the exported header");

    const res = await ctx.client.createTableImport(DEST_TABLE, {
      file: exportedCsv,
      mappings: mappable.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
    assertStatusIn(res, [200], "importing a BI Table export into a Peaka Table");
    assertEqual(res.body.result.processed, expectedRows, "rows processed on the migration");

    const count = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."table"."${DEST_TABLE}"` },
      "SIMPLE"
    );
    assertStatusIn(count, [200], "COUNT(*) on the destination");
    assertEqual(
      Number(count.body.data[0].cnt),
      expectedRows,
      `rows in the destination Peaka Table. This is the only route by which BI Table data reaches a table ` +
        `the Partner API can write to`
    );
    console.log(`  migrated ${expectedRows} rows from the BI Table into a Peaka Table`);
  });

  await step("delete the destination table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(DEST_TABLE);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    const idx = ctx.createdInternalTableNames.indexOf(DEST_TABLE);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const list = await ctx.client.listInternalTables();
    assert(
      !(list.body || []).some((t) => t.tableName === DEST_TABLE),
      `'${DEST_TABLE}' still appears in listInternalTables() after delete`
    );
  });
}

module.exports = { runBiTableExport };
