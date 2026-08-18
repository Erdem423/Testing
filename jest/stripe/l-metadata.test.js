/**
 * L: Metadata Refresh Endpoints
 * -----------------------------
 * Metadata refresh and its status polling. Runs against a catalog it creates
 * ITSELF - refreshing the shared PEAKA_CATALOG_ID while B reads metadata and
 * C queries it would be a real interference risk.
 *
 * Runs in its OWN file so Jest schedules it in a separate worker process,
 * genuinely in parallel with the other scenarios rather than interleaved on
 * one worker the way test.concurrent() works. Each file builds its own ctx
 * (helpers/buildCtx.js) and cleans up after itself, so nothing is shared.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gateFor } = require("../../helpers/preflight");
const { runMetadata } = require("../../tests/stripe/l-metadata");

let ctx = null;

// NO TOKEN CHECK ANY MORE. This used to create its own Stripe CONNECTION,
// which needed STRIPE_TEST_TOKEN; it now provisions its catalog on the
// connection the suite is already configured against (see
// helpers/provisionCatalog.js), so the only thing that can gate it is the
// ordinary preflight question of whether there is data to work with.
const gate = gateFor("L: Metadata Refresh Endpoints", "stripe.configured");

(gate.ok ? test : test.skip)(
  gate.name,
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("L: Metadata Refresh Endpoints", () => runMetadata(ctx));
  },
  240000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  const hasResources =
    ctx.createdCacheIds.length > 0 ||
    ctx.createdQueryIds.length > 0 ||
    ctx.createdInternalTableNames.length > 0 ||
    ctx.createdCatalogIds.length > 0 ||
    ctx.createdConnectionIds.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 120000);
