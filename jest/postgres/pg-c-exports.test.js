/**
 * PG-C: Export Endpoints
 * ----------------------
 * The Postgres half of the export-cap attribution claim - see
 * tests/postgres/pg-c-exports.js and its Stripe counterpart, tests/stripe/k-exports.js.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPgExports } = require("../../tests/postgres/pg-c-exports");

let ctx = null;

// GATED on a table large enough to tell an uncapped export from a capped one -
// the entire claim of the headline step.
gatedTest(
  "PG-C: Export Endpoints",
  "postgres.largeTable",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-C: Export Endpoints", () => runPgExports(ctx));
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
