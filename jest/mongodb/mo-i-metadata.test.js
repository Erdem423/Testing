/**
 * MO-I: Metadata Refresh Endpoints
 * --------------------------------
 * See tests/mongodb/mo-i-metadata.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runMoMetadata } = require("../../tests/mongodb/mo-i-metadata");

let ctx = null;

// GATED on the connector being configured. Reuses the existing connection, so it needs no database credentials.
gatedTest(
  "MO-I: Metadata Refresh Endpoints",
  "mongodb.connectionId",
  async () => {
    requireCredentials("mongodb");
    ctx = buildFreshCtx("mongodb");
    ctx.runTag = runTag();
    await withScenario("MO-I: Metadata Refresh Endpoints", () => runMoMetadata(ctx));
  },
  // The connect2 connection has only 2 collections across 2 databases, far
  // smaller than Postgres's 10-schema instance (which needed 6 min) - kept
  // generous rather than tuned tight, per mo-i-metadata.js's module comment.
  240000
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
