/**
 * H: Catalog Endpoints (HubSpot)
 * -------------------------------
 * HubSpot version of jest/stripe/h-catalogs.test.js. Catalog lifecycle plus
 * project-wide search and table statistics.
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
const { runCatalogs } = require("../../tests/hubspot/h-catalogs");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const gate = skipUnless(check, "H: Catalog Endpoints", "It creates and deletes its own catalog, so it needs its own connection - it must never touch the shared PEAKA_HUBSPOT_CATALOG_ID, and Peaka 500s on attaching a second catalog to an existing connection.");
const maybeTest = gate.ok ? test : test.skip;
if (!gate.ok) console.warn(`Skipping ${gate.name}`);
maybeTest(
  gate.name,
  async () => {
    requireCredentials("hubspot");
    ctx = buildFreshCtx("hubspot");
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
