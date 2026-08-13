/**
 * MO-F: Error Handling & Pagination
 * ---------------------------------
 * See tests/mongodb/mo-f-error-handling.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { runMoErrorHandling } = require("../../tests/mongodb/mo-f-error-handling");

// GATED on a large collection: the pagination step deliberately pages BEYOND
// the Stripe cap, which needs a collection big enough to have rows there.
gatedTest(
  "MO-F: Error Handling & Pagination",
  "mongodb.largeTable",
  async () => {
    requireCredentials("mongodb");
    const ctx = buildFreshCtx("mongodb");
    ctx.runTag = runTag();
    await withScenario("MO-F: Error Handling & Pagination", () => runMoErrorHandling(ctx));
  },
  120000
);
