/**
 * H: Catalog Endpoints
 * --------------------
 * Catalog lifecycle plus project-wide search and table statistics. Creates
 * its own connection AND catalog - catalog creation triggers metadata
 * discovery over 113 tables, hence the longer timeout.
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
const { runCatalogs } = require("../../tests/stripe/h-catalogs");

let ctx = null;

// TWO REASONS THIS CAN SKIP, reported separately. The preflight gate covers
// "the connector has no data to work with"; the token check covers "this one
// creates a Stripe connection and there is no key to create it with". Both
// are legitimate, and collapsing them lost the distinction - see
// tests/stripe/checkTokenCredentials.js.
const tokenCheck = checkWithToken();
const gate = tokenCheck.ok
  ? gateFor("H: Catalog Endpoints", "stripe.configured")
  : skipUnless(tokenCheck, "H: Catalog Endpoints", "It creates and deletes its own connection and catalog, so it never touches the shared PEAKA_CATALOG_ID every other scenario reads.");

(gate.ok ? test : test.skip)(
  gate.name,
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("H: Catalog Endpoints", () => runCatalogs(ctx));
  },
  180000
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
