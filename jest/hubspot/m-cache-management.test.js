/**
 * M: Cache Management Endpoints (HubSpot)
 * -----------------------------------------
 * HubSpot version of jest/stripe/m-cache-management.test.js. Cache settings,
 * batch creation, the three all-statuses variants, execution history and the
 * trigger/cancel pairs.
 *
 * Runs in its OWN file so Jest schedules it in a separate worker process.
 * Each file builds its own ctx (helpers/buildCtx.js) and cleans up after
 * itself, so nothing is shared.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { skipUnless } = require("../../helpers/preflight");
const { checkWithToken } = require("../../tests/hubspot/checkTokenCredentials");
const check = checkWithToken();
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runCacheManagement } = require("../../tests/hubspot/m-cache-management");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const gate = skipUnless(check, "M: Cache Management Endpoints", "It caches fixture tables in a private catalog so it cannot collide with C's cached tables in the shared one - and a private catalog needs its own connection.");
const maybeTest = gate.ok ? test : test.skip;
if (!gate.ok) console.warn(`Skipping ${gate.name}`);
maybeTest(
  gate.name,
  async () => {
    requireCredentials("hubspot");
    ctx = buildFreshCtx("hubspot");
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
