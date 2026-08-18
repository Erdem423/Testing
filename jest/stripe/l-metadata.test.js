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
const { gateFor, skipUnless } = require("../../helpers/preflight");
const { checkWithToken } = require("../../tests/stripe/checkTokenCredentials");
const { runMetadata } = require("../../tests/stripe/l-metadata");

let ctx = null;

// TWO REASONS THIS CAN SKIP, reported separately. The preflight gate covers
// "the connector has no data to work with"; the token check covers "this one
// creates a Stripe connection and there is no key to create it with". Both
// are legitimate, and collapsing them lost the distinction - see
// tests/stripe/checkTokenCredentials.js.
const tokenCheck = checkWithToken();
const gate = tokenCheck.ok
  ? gateFor("L: Metadata Refresh Endpoints", "stripe.configured")
  : skipUnless(tokenCheck, "L: Metadata Refresh Endpoints", "It refreshes metadata on a catalog it provisions itself - doing that to the shared catalog while B and C are reading it would corrupt their results.");

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
