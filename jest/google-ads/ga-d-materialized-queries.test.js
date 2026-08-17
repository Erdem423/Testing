/**
 * GA-D: Materialized Query Endpoints
 * ----------------------------------
 * The Google Ads half of the materialization-cap finding - see
 * tests/google-ads/ga-d-materialized-queries.js.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runGaMaterializedQueries } = require("../../tests/google-ads/ga-d-materialized-queries");

let ctx = null;

gatedTest(
  "GA-D: Materialized Query Endpoints",
  "googleAds.anyTable",
  async () => {
    requireCredentials("google-ads");
    ctx = buildFreshCtx("google-ads");
    ctx.runTag = runTag();
    await withScenario("GA-D: Materialized Query Endpoints", () => runGaMaterializedQueries(ctx));
  },
  400000
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
