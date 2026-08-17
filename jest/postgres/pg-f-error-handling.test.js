/**
 * PG-F: Error Handling & Pagination
 * ---------------------------------
 * See tests/postgres/pg-f-error-handling.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPgErrorHandling } = require("../../tests/postgres/pg-f-error-handling");

let ctx = null;

// GATED on a large table: the pagination step deliberately pages BEYOND the Stripe cap, which needs a table big enough to have rows there.
gatedTest(
  "PG-F: Error Handling & Pagination",
  "postgres.anyTable",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-F: Error Handling & Pagination", () => runPgErrorHandling(ctx));
  },
  120000
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
