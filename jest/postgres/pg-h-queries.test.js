/**
 * PG-H: Saved Query Endpoints
 * ---------------------------
 * See tests/postgres/pg-h-queries.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPgQueries } = require("../../tests/postgres/pg-h-queries");

let ctx = null;

// GATED on a large table: the execute-by-name step asserts a saved query sees the WHOLE table rather than the Stripe cap.
gatedTest(
  "PG-H: Saved Query Endpoints",
  "postgres.largeTable",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-H: Saved Query Endpoints", () => runPgQueries(ctx));
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
