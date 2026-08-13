/**
 * MO-G: Catalog Endpoints
 * -----------------------
 * See tests/mongodb/mo-g-catalogs.js for what this asserts and why -
 * including the inverted table-statistics finding.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runMoCatalogs } = require("../../tests/mongodb/mo-g-catalogs");

let ctx = null;

// GATED on the connector being configured. Reuses the existing connection, so it needs no database credentials.
gatedTest(
  "MO-G: Catalog Endpoints",
  "mongodb.connectionId",
  async () => {
    requireCredentials("mongodb");
    ctx = buildFreshCtx("mongodb");
    ctx.runTag = runTag();
    await withScenario("MO-G: Catalog Endpoints", () => runMoCatalogs(ctx));
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
