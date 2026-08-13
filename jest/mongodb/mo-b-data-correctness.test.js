/**
 * MO-B: Data Correctness
 * -----------------------
 * See tests/mongodb/mo-b-data-correctness.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { runMoDataCorrectness } = require("../../tests/mongodb/mo-b-data-correctness");

// GATED: this scenario's whole claim is "the ~100-row cap does not apply to a
// database connector". A schema whose largest collection is under that
// threshold cannot demonstrate it either way, so the claim is untestable
// rather than false.
gatedTest(
  "MO-B: Data Correctness",
  "mongodb.largeTable",
  async () => {
    requireCredentials("mongodb");
    const ctx = buildFreshCtx("mongodb");
    ctx.runTag = runTag();
    await withScenario("MO-B: Data Correctness", () => runMoDataCorrectness(ctx));
  },
  // Fetching 25,000 rows to cross-check the aggregate is the slow part.
  180000
);
