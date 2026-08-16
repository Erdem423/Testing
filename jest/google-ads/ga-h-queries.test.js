/**
 * GA-H: Saved Query Endpoints
 * ---------------------------
 * See tests/google-ads/ga-h-queries.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runGaQueries } = require("../../tests/google-ads/ga-h-queries");

let ctx = null;

gatedTest(
  "GA-H: Saved Query Endpoints",
  "googleAds.largeTable",
  async () => {
    requireCredentials("google-ads");
    ctx = buildFreshCtx("google-ads");
    ctx.runTag = runTag();
    await withScenario("GA-H: Saved Query Endpoints", () => runGaQueries(ctx));
  },
  180000
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
