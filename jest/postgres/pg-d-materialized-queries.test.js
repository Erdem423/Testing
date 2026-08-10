/**
 * PG-D: Materialized Query Endpoints
 * ----------------------------------
 * The Postgres half of the materialization-cap finding - see
 * tests/postgres/pg-d-materialized-queries.js and its Stripe counterpart,
 * tests/stripe/n-materialized-queries.js.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPgMaterializedQueries } = require("../../tests/postgres/pg-d-materialized-queries");

let ctx = null;

// GATED on a table bigger than the live cap - without one, "the materialized
// result is not capped" cannot be distinguished from "it happens to be small".
gatedTest(
  "PG-D: Materialized Query Endpoints",
  "postgres.largeTable",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-D: Materialized Query Endpoints", () => runPgMaterializedQueries(ctx));
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
