/**
 * GA-A: Catalog & Schema Discovery
 * --------------------------------
 * The first scenario for the fourth connector, and the first one outside the
 * main Peaka project. Same shape as jest/mongodb/mo-a-discovery.test.js - the
 * only structural difference is buildFreshCtx("google-ads"), which resolves a
 * separate API key and project id via tests/google-ads/config.js.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gatedTest } = require("../../helpers/preflight");
const { runGaDiscovery } = require("../../tests/google-ads/ga-a-discovery");

let ctx = null;

// GATED on a table over 100 rows - the cap-confirmation step needs one to
// distinguish "uncapped" from "capped at 100". Retries inside the scenario
// itself account for this connector's measured flakiness; this timeout
// budget is generous to give those retries room.
gatedTest(
  "GA-A: Catalog & Schema Discovery",
  "googleAds.anyTable",
  async () => {
    requireCredentials("google-ads");
    ctx = buildFreshCtx("google-ads");
    ctx.runTag = runTag();
    await withScenario("GA-A: Catalog & Schema Discovery", () => runGaDiscovery(ctx));
  },
  180000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // Creates nothing under normal conditions - runs anyway because one step
  // deliberately attempts a createCache to prove the rejection is enforced.
  if (ctx.createdCacheIds.length === 0) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
