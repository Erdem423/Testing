/**
 * M: Cache Management Endpoints
 * -----------------------------
 * Cache settings, batch creation, the three all-statuses variants, execution
 * history and the trigger/cancel pairs. This is the scenario that finally
 * exercises the four cache endpoints whose paths were corrected in PR #3 but
 * which no test had ever called.
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
const { runCacheManagement } = require("../../tests/stripe/m-cache-management");

let ctx = null;

// TWO REASONS THIS CAN SKIP, reported separately. The preflight gate covers
// "the connector has no data to work with"; the token check covers "this one
// creates a Stripe connection and there is no key to create it with". Both
// are legitimate, and collapsing them lost the distinction - see
// tests/stripe/checkTokenCredentials.js.
const tokenCheck = checkWithToken();
const gate = tokenCheck.ok
  ? gateFor("M: Cache Management Endpoints", "stripe.configured")
  : skipUnless(tokenCheck, "M: Cache Management Endpoints", "It caches fixture tables in a connection and catalog it provisions itself, so it cannot collide with C's caches in the shared catalog.");

(gate.ok ? test : test.skip)(
  gate.name,
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("M: Cache Management Endpoints", () => runCacheManagement(ctx));
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
