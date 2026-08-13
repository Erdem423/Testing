/**
 * A materialized query over a BI Table agrees with the table underneath
 * ---------------------------------------------------------------------
 * Deliberately does NOT claim whether a snapshot is held - with no write path
 * the base cannot be made to drift, so that is undeterminable here.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gatedTest } = require("../../helpers/preflight");
const { runBiTableMaterialized } = require("../../tests/peaka-tables/bitable-materialized");

let ctx = null;

gatedTest(
  "A materialized query over a BI Table agrees with the table underneath",
  "peakaTables.biTableWithData",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("A materialized query over a BI Table agrees with the table underneath", () => runBiTableMaterialized(ctx));
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
