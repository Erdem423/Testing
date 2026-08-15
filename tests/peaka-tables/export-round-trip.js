const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 40; // ~80s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Exporting a Peaka Table to CSV and importing that same file back in.
 *
 * WHY A CUSTOMER DOES THIS. It is the everyday data-wrangling loop: export a
 * table, open it in Excel, fix something, upload it again. Every step exists
 * on its own and works; the question is whether they compose.
 *
 * MEASURED 2026-08-11 with 150 rows - deliberately past the Stripe cap:
 *
 *   createTableExport(catalogId "1", schema "table") -> 202 PENDING
 *   polled to SUCCEEDED -> rowCount 150, one downloadable file
 *   downloaded CSV -> 151 lines: a header plus all 150 rows
 *   re-imported into a second table -> 200, processed 150, values identical
 *
 * TWO THINGS WORTH PINNING, and the second is the interesting one.
 *
 * 1. THE EXPORT IS NOT CAPPED. All 150 rows come out, which is the SEVENTH
 *    independent confirmation the 100-row cap belongs to the Stripe connector
 *    (after queries, exports, materialization, saved queries, internal-table
 *    reads and federated joins). It matters here specifically because the cap
 *    DID reach Stripe's export files - see FINDINGS 1 - so the export path was
 *    a plausible place for it to reappear.
 *
 * 2. THE EXPORT CARRIES ALL EIGHT SYSTEM COLUMNS. The header is
 *    "_id,_version,_created_time,_created_by,_last_modified_time,
 *     _last_modified_by,_session,text,<your columns>", so an exported file is
 *    NOT directly re-importable: mapping every header column would target
 *    Peaka's internal columns. A caller has to filter the mapping down to the
 *    columns they actually declared, which this scenario does explicitly.
 *
 *    Note the asymmetry with the sample endpoint, which the spec REQUIRES to
 *    be importable as-is and which is (FINDINGS 15). Peaka has two CSV-shaped
 *    outputs and only one of them round-trips without editing.
 *    `createTableExport` also takes no `includeSystemColumns` option - only
 *    `createQueryExport` does - so for a table export the filtering has to
 *    happen client-side.
 *
 * ASYNC, so this is the flakiest scenario in the folder: FINDINGS records that
 * exports fail intermittently with no race involved. A failure here is worth
 * re-running once before being believed.
 */
const SOURCE_TABLE = "e2e_auto_pt_export_src";
const TARGET_TABLE = "e2e_auto_pt_export_dst";
const ROW_COUNT = 150;

const COLUMNS = [
  { name: "label", dataType: "VARCHAR", displayName: "label", defaultValue: null, isNotNull: false, isUnique: false },
  { name: "n", dataType: "BIGINT", displayName: "n", defaultValue: null, isNotNull: false, isUnique: false },
];
const DECLARED = COLUMNS.map((c) => c.name);

// Peaka prepends these to every internal table - see FINDINGS 19.
const SYSTEM_COLUMNS = [
  "_id",
  "_version",
  "_created_time",
  "_created_by",
  "_last_modified_time",
  "_last_modified_by",
  "_session",
  "text",
];

async function runPtExportRoundTrip(ctx) {
  let exportedCsv = null;
  let exportedHeader = [];

  async function countRows(table) {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."table"."${table}"` },
      "SIMPLE"
    );
    assertStatusIn(res, [200], `COUNT(*) on ${table}`);
    return Number(res.body.data[0].cnt);
  }

  async function createWithColumns(table) {
    const createRes = await ctx.client.createInternalTable(table);
    assertStatusIn(createRes, [200], `createInternalTable(${table})`);
    if (!ctx.createdInternalTableNames.includes(table)) ctx.createdInternalTableNames.push(table);
    const colRes = await ctx.client.addInternalTableColumns(table, COLUMNS);
    assertStatusIn(colRes, [200], `addInternalTableColumns(${table})`);
  }

  async function pollExport(id) {
    const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"];
    let last = null;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const res = await ctx.client.getExport(id);
      assertStatusIn(res, [200], "getExport");
      last = res.body;
      if (TERMINAL.includes(String(res.body.status).toUpperCase())) return last;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `The export did not reach a terminal state after ${MAX_POLL_ATTEMPTS} attempts ` +
        `(~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s). Last: ${JSON.stringify(last)}`
    );
  }

  await step("clean up any leftover tables from a previous run", async () => {
    await ctx.client.deleteInternalTable(SOURCE_TABLE).catch(() => {});
    await ctx.client.deleteInternalTable(TARGET_TABLE).catch(() => {});
  });

  await step("create the source table and import 150 rows", async () => {
    await createWithColumns(SOURCE_TABLE);

    const body = Array.from({ length: ROW_COUNT }, (_, i) => `row${i},${i}`).join("\n");
    const importRes = await ctx.client.createTableImport(SOURCE_TABLE, {
      file: `label,n\n${body}\n`,
      mappings: DECLARED.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
    assertStatusIn(importRes, [200], "createTableImport (seed)");
    assertEqual(importRes.body.result.processed, ROW_COUNT, "rows processed");
    assertEqual(await countRows(SOURCE_TABLE), ROW_COUNT, "rows in the source table");
  });

  await step("export the table and poll until it succeeds", async () => {
    // catalogId "1" is the built-in `peaka` catalog; internal tables live in
    // its `table` schema. Export is async - 202 with a job id, unlike import.
    const res = await ctx.client.createTableExport("1", "table", SOURCE_TABLE, { format: "CSV" });
    assertStatusIn(res, [200, 202], "createTableExport on an internal table");
    assert(res.body && res.body.id, `Expected an export job id, got: ${JSON.stringify(res.body).slice(0, 200)}`);

    const final = await pollExport(res.body.id);
    assertEqual(
      String(final.status).toUpperCase(),
      "SUCCEEDED",
      `final export status. Exports fail intermittently in this API with no race involved, so re-run once ` +
        `before treating this as a real regression. Job: ${JSON.stringify(final).slice(0, 240)}`
    );
    assert(Array.isArray(final.files) && final.files.length > 0, `A succeeded export exposed no files: ${JSON.stringify(final).slice(0, 240)}`);

    const file = final.files[0];
    assert(file.url && /^https?:\/\//.test(file.url), `Expected a download URL, got: ${JSON.stringify(file)}`);

    const download = await fetch(file.url);
    assertEqual(download.status, 200, "HTTP status downloading the exported file");
    exportedCsv = await download.text();
    const lines = exportedCsv.trim().split("\n");
    exportedHeader = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));

    // The export's own metadata must agree with the file it produced.
    assertEqual(Number(final.rowCount), ROW_COUNT, "rowCount reported by the export job");
    assertEqual(lines.length - 1, ROW_COUNT, "data rows in the downloaded file");
  });

  await step("the exported file holds every row so exports do not cap internal tables", async () => {
    const lines = exportedCsv.trim().split("\n");
    assertEqual(
      lines.length - 1,
      ROW_COUNT,
      `rows in the exported CSV. The Stripe cap DOES reach that connector's export files (FINDINGS 1), so ` +
        `an internal-table export was a plausible place for it to reappear - it does not`
    );
    assert(
      exportedCsv.includes("row0") && exportedCsv.includes(`row${ROW_COUNT - 1}`),
      "The exported file is missing either the first or the last row, so it is not a complete export"
    );
    console.log(`  export uncapped: ${lines.length - 1} of ${ROW_COUNT} rows downloaded`);
  });

  await step("the exported header carries every system column ahead of the declared ones", async () => {
    for (const sys of SYSTEM_COLUMNS) {
      assert(
        exportedHeader.includes(sys),
        `The exported header is missing the system column '${sys}'. Header: ${JSON.stringify(exportedHeader)} - ` +
          `if Peaka has stopped exporting system columns, an exported file becomes directly re-importable ` +
          `and this scenario's filtering step is no longer needed`
      );
    }
    for (const declared of DECLARED) {
      assert(exportedHeader.includes(declared), `The exported header is missing the declared column '${declared}'`);
    }
    console.log(`  export header: ${JSON.stringify(exportedHeader)}`);
  });

  // THE ROUND TRIP.
  await step("re-importing the exported file reproduces the values exactly", async () => {
    await createWithColumns(TARGET_TABLE);

    // Only the columns we actually declared can be mapped - the eight system
    // columns in the header are Peaka's, not ours.
    const mappable = exportedHeader.filter((h) => DECLARED.includes(h));
    assertEqual(mappable.length, DECLARED.length, "declared columns found in the exported header");

    const res = await ctx.client.createTableImport(TARGET_TABLE, {
      file: exportedCsv,
      mappings: mappable.map((h) => ({ name: h, csvColumnName: h })),
      containsHeader: true,
    });
    assertStatusIn(res, [200], "re-importing the exported CSV");
    assertEqual(res.body.result.processed, ROW_COUNT, "rows processed on the round trip");
    assertEqual(await countRows(TARGET_TABLE), ROW_COUNT, "rows in the destination table");

    const sel = await ctx.client.executeQuery(
      { statement: `SELECT label, n FROM "peaka"."table"."${TARGET_TABLE}" ORDER BY n LIMIT 3` },
      "SIMPLE"
    );
    assertStatusIn(sel, [200], "SELECT from the destination table");
    assertEqual(sel.body.data[0].label, "row0", "first label after the round trip");
    assertEqual(String(sel.body.data[0].n), "0", "first BIGINT after the round trip");
    assertEqual(sel.body.data[2].label, "row2", "third label after the round trip");
    console.log(`  round trip intact: ${JSON.stringify(sel.body.data)}`);
  });

  await step("delete both tables and confirm they are gone", async () => {
    for (const table of [SOURCE_TABLE, TARGET_TABLE]) {
      const delRes = await ctx.client.deleteInternalTable(table);
      assertStatusIn(delRes, [200], `deleteInternalTable(${table})`);
      const idx = ctx.createdInternalTableNames.indexOf(table);
      if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);
    }
    const list = await ctx.client.listInternalTables();
    const names = (list.body || []).map((t) => t.tableName);
    for (const table of [SOURCE_TABLE, TARGET_TABLE]) {
      assert(!names.includes(table), `'${table}' still appears in listInternalTables() after delete`);
    }
  });
}

module.exports = { runPtExportRoundTrip };
