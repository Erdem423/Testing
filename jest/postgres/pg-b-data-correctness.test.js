/**
 * PG-B: Data Correctness
 * ----------------------
 * The mirror image of Stripe's C: asserts the 100-row cap does NOT apply to a
 * database connector, which is what makes the cap connector-specific rather
 * than a Peaka-wide bug. See tests/postgres/pg-b-data-correctness.js.
 *
 * Read-only - it queries an existing catalog and creates nothing.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { gatedTest } = require("../../helpers/preflight");
const { runPgDataCorrectness } = require("../../tests/postgres/pg-b-data-correctness");

let ctx = null;

// GATED: this scenario's whole claim is "the ~100-row cap does not apply to a
// database connector". A schema whose largest table is under that threshold
// cannot demonstrate it either way, so the claim is untestable rather than false.
gatedTest(
  "PG-B: Data Correctness",
  "postgres.largeTable",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-B: Data Correctness", () => runPgDataCorrectness(ctx));
  },
  // Fetching 25,000 rows to cross-check the aggregate is the slow part.
  180000
);
