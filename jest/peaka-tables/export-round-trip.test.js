/**
 * Data survives an export and re-import unchanged
 * -------------------------------------------------
 * See tests/peaka-tables/export-round-trip.js. The everyday Excel loop -
 * export, edit, re-upload - and it works, with one catch: the exported header
 * carries all eight system columns, so the mapping has to be filtered.
 *
 * ASYNC and therefore the flakiest scenario in this folder. FINDINGS records
 * that exports fail intermittently with no race involved, so re-run once
 * before treating a red result here as a regression.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtExportRoundTrip } = require("../../tests/peaka-tables/export-round-trip");

let ctx = null;

test(
  "Data survives an export and re-import unchanged",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("Data survives an export and re-import unchanged", () => runPtExportRoundTrip(ctx));
  },
  180000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  const hasResources =
    ctx.createdInternalTableNames.length > 0 || ctx.createdBiTableNames.length > 0 || ctx.createdQueryIds.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
