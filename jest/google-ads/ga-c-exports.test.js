/**
 * GA-C: Export Endpoints
 * ----------------------
 * The Google Ads half of the export-cap attribution claim - see
 * tests/google-ads/ga-c-exports.js.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runGaExports } = require("../../tests/google-ads/ga-c-exports");

let ctx = null;

gatedTest(
  "GA-C: Export Endpoints",
  "googleAds.largeTable",
  async () => {
    requireCredentials("google-ads");
    ctx = buildFreshCtx("google-ads");
    ctx.runTag = runTag();
    await withScenario("GA-C: Export Endpoints", () => runGaExports(ctx));
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
