/**
 * MO-C: Export Endpoints
 * ----------------------
 * The MongoDB half of the export-cap attribution claim - see
 * tests/mongodb/mo-c-exports.js.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runMoExports } = require("../../tests/mongodb/mo-c-exports");

let ctx = null;

// GATED on a collection large enough to tell an uncapped export from a
// capped one - the entire claim of the headline step.
gatedTest(
  "MO-C: Export Endpoints",
  "mongodb.largeTable",
  async () => {
    requireCredentials("mongodb");
    ctx = buildFreshCtx("mongodb");
    ctx.runTag = runTag();
    await withScenario("MO-C: Export Endpoints", () => runMoExports(ctx));
  },
  300000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  const hasResources = ctx.createdQueryIds.length > 0 || ctx.createdCatalogIds.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 120000);
