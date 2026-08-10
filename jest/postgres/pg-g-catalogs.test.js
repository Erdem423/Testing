/**
 * PG-G: Catalog Endpoints
 * -----------------------
 * See tests/postgres/pg-g-catalogs.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPgCatalogs } = require("../../tests/postgres/pg-g-catalogs");

let ctx = null;

// GATED on the connector being configured. Reuses the existing connection, so it needs no database credentials.
gatedTest(
  "PG-G: Catalog Endpoints",
  "postgres.anyTable",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-G: Catalog Endpoints", () => runPgCatalogs(ctx));
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
