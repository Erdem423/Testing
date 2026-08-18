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
const { buildFreshCtx, requireCredentials, runTag, checkFor } = require("../../helpers/buildCtx");
const { skipUnless } = require("../../helpers/preflight");
const check = checkFor("hubspot");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runExports } = require("../../tests/hubspot/k-exports");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const gate = skipUnless(check, "K: Export Endpoints", "This one reads the shared catalog only - it needs no HubSpot token, just the connector's own settings.");
const maybeTest = gate.ok ? test : test.skip;
if (!gate.ok) console.warn(`Skipping ${gate.name}`);
maybeTest(
  gate.name,
  async () => {
    requireCredentials("hubspot");
    ctx = buildFreshCtx("hubspot");
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
