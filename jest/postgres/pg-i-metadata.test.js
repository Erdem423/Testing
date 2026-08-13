/**
 * PG-I: Metadata Refresh Endpoints
 * --------------------------------
 * See tests/postgres/pg-i-metadata.js for what this asserts and why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPgMetadata } = require("../../tests/postgres/pg-i-metadata");

let ctx = null;

// GATED on the connector being configured. Reuses the existing connection, so it needs no database credentials.
gatedTest(
  "PG-I: Metadata Refresh Endpoints",
  "postgres.connectionId",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-I: Metadata Refresh Endpoints", () => runPgMetadata(ctx));
  },
  // 6 min: the refresh itself is budgeted ~5 (see MAX_POLL_ATTEMPTS in the
  // scenario - a Postgres catalog refresh walks the whole database, unlike
  // Stripe's 4 tables), plus room for the catalog create/delete around it.
  360000
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
