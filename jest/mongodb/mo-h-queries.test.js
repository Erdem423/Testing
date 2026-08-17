/**
 * MO-H: Saved Query Endpoints
 * ---------------------------
 * See tests/mongodb/mo-h-queries.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runMoQueries } = require("../../tests/mongodb/mo-h-queries");

let ctx = null;

// GATED on a large collection: the execute-by-name step asserts a saved
// query sees the WHOLE collection rather than the Stripe cap.
gatedTest(
  "MO-H: Saved Query Endpoints",
  "mongodb.anyTable",
  async () => {
    requireCredentials("mongodb");
    ctx = buildFreshCtx("mongodb");
    ctx.runTag = runTag();
    await withScenario("MO-H: Saved Query Endpoints", () => runMoQueries(ctx));
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
