/**
 * I: Saved Query Endpoints (HubSpot)
 * ----------------------------------
 * HubSpot version of jest/stripe/i-queries.test.js. Needs no connection or
 * catalog beyond the pre-existing one - a saved query's SQL is just stored
 * text - so this is the cheapest scenario, same as the Stripe version.
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
const { runQueries } = require("../../tests/hubspot/i-queries");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const maybeTest = check.ok ? test : test.skip;
if (!check.ok) console.warn(`Skipping I: Saved Query Endpoints (HubSpot) - credentials not configured:\n${check.errors.join("\n")}`);

maybeTest(
  "I: Saved Query Endpoints",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("I: Saved Query Endpoints", () => runQueries(ctx));
  },
  60000
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
