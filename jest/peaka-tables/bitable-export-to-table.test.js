/**
 * A BI Table exports into a Peaka Table which is the only way out
 * ---------------------------------------------------------------
 * No import route exists for the bitable path, so the round trip lands in a
 * Peaka Table - the only internal destination that accepts writes. ASYNC.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gatedTest } = require("../../helpers/preflight");
const { runBiTableExport } = require("../../tests/peaka-tables/bitable-export-to-table");

let ctx = null;

gatedTest(
  "A BI Table exports into a Peaka Table which is the only way out",
  "peakaTables.biTableWithData",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("A BI Table exports into a Peaka Table which is the only way out", () => runBiTableExport(ctx));
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
