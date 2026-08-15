/**
 * K: Export Endpoints (HubSpot)
 * -----------------------------
 * HubSpot version of jest/stripe/k-exports.test.js. Async CSV export from a
 * saved query: start, poll to SUCCEEDED, read, list, cancel.
 *
 * Runs in its OWN file so Jest schedules it in a separate worker process.
 * Each file builds its own ctx (helpers/buildCtx.js) and cleans up after
 * itself, so nothing is shared.
 */
// requireToken: false - this scenario never calls createConnection, so
// HUBSPOT_ACCESS_TOKEN isn't needed (see helpers/env.js's checkCredentials).
const {
  buildFreshCtx,
  requireCredentials,
  runTag,
  credentialCheck: check,
} = require("../../helpers/buildCtx")("hubspot", { requireToken: false });
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runExports } = require("../../tests/hubspot/k-exports");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const maybeTest = check.ok ? test : test.skip;
if (!check.ok) console.warn(`Skipping K: Export Endpoints (HubSpot) - credentials not configured:\n${check.errors.join("\n")}`);

maybeTest(
  "K: Export Endpoints",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("K: Export Endpoints", () => runExports(ctx));
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
