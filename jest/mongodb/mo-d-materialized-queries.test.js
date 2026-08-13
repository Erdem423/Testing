/**
 * MO-D: Materialized Query Endpoints
 * ----------------------------------
 * The MongoDB half of the materialization-cap finding - see
 * tests/mongodb/mo-d-materialized-queries.js.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runMoMaterializedQueries } = require("../../tests/mongodb/mo-d-materialized-queries");

let ctx = null;

// GATED on a collection bigger than the live cap - without one, "the
// materialized result is not capped" cannot be distinguished from "it
// happens to be small".
gatedTest(
  "MO-D: Materialized Query Endpoints",
  "mongodb.largeTable",
  async () => {
    requireCredentials("mongodb");
    ctx = buildFreshCtx("mongodb");
    ctx.runTag = runTag();
    await withScenario("MO-D: Materialized Query Endpoints", () => runMoMaterializedQueries(ctx));
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
