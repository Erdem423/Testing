/**
 * PG-A: Catalog & Schema Discovery
 * --------------------------------
 * The first scenario for a second connector, and the real test of the repo's
 * "a new connector needs zero core changes" claim - see tests/postgres/meta.js.
 *
 * Note the ONLY difference from a Stripe test file: buildFreshCtx("postgres").
 * Everything else - requireCredentials, withScenario, cleanup - is identical,
 * which is the point.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gatedTest } = require("../../helpers/preflight");
const { runPgDiscovery } = require("../../tests/postgres/pg-a-discovery");

let ctx = null;

// GATED on the connector being configured and its schema having tables at all -
// without a Postgres catalog in .env there is nothing here to discover.
gatedTest(
  "PG-A: Catalog & Schema Discovery",
  "postgres.anyTable",
  async () => {
    requireCredentials("postgres");
    ctx = buildFreshCtx("postgres");
    ctx.runTag = runTag();
    await withScenario("PG-A: Catalog & Schema Discovery", () => runPgDiscovery(ctx));
  },
  120000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // This scenario creates nothing, so cleanup normally has nothing to do. It
  // runs anyway because one step DELIBERATELY attempts a createCache to prove
  // the rejection is enforced - if Peaka ever starts allowing it, that cache is
  // real and needs removing.
  const hasResources = ctx.createdCacheIds.length > 0 || ctx.createdCatalogIds.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
