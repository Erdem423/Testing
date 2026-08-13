/**
 * BI Table rows are queryable and join to a Peaka Table
 * -------------------------------------------------------
 * See tests/peaka-tables/bitable-read-and-join.js. Closes the spec's CMP-02,
 * which had been substituted for a Table x Table join because nothing in the
 * Partner API can seed a BI Table.
 *
 * GATED on peakaTables.biTableWithData - the second gatedTest in this folder,
 * and the reason preflight now has a peakaTables branch at all. BI Table rows
 * can only be entered through Studio, so a project without them has nothing to
 * assert against and must skip rather than fail.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gatedTest } = require("../../helpers/preflight");
const { runBiTableRead } = require("../../tests/peaka-tables/bitable-read-and-join");

let ctx = null;

gatedTest(
  "BI Table rows are queryable and join to a Peaka Table",
  "peakaTables.biTableWithData",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("BI Table rows are queryable and join to a Peaka Table", () => runBiTableRead(ctx));
  },
  120000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  const hasResources = ctx.createdInternalTableNames.length > 0 || ctx.createdBiTableNames.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
