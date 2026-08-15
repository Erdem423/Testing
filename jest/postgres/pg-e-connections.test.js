/**
 * PG-E: Connection Endpoints
 * --------------------------
 * The only Postgres scenario needing real database credentials - see
 * tests/postgres/pg-e-connections.js. Skips cleanly when they are absent.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPgConnections } = require("../../tests/postgres/pg-e-connections");

let ctx = null;

// GATED on the six PEAKA_PG_* connection variables. Every other scenario in
// this folder reuses the existing connection and needs none of them, so their
// absence must skip this one rather than fail the folder.
gatedTest(
  "PG-E: Connection Endpoints",
  "postgres.credentials",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-E: Connection Endpoints", () => runPgConnections(ctx));
  },
  180000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // Matters more here than anywhere else in the folder: a leftover is a live
  // connection holding real database credentials, not just debris.
  const hasResources = ctx.createdConnectionIds.length > 0 || ctx.createdCatalogIds.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 120000);
