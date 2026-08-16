/**
 * GA-F: Error Handling & Pagination
 * ---------------------------------
 * See tests/google-ads/ga-f-error-handling.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { runGaErrorHandling } = require("../../tests/google-ads/ga-f-error-handling");

gatedTest(
  "GA-F: Error Handling & Pagination",
  "googleAds.largeTable",
  async () => {
    requireCredentials("google-ads");
    const ctx = buildFreshCtx("google-ads");
    ctx.runTag = runTag();
    await withScenario("GA-F: Error Handling & Pagination", () => runGaErrorHandling(ctx));
  },
  120000
);
