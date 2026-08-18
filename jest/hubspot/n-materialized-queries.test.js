/**
 * N: Materialized Query Endpoints (HubSpot)
 * -------------------------------------------
 * HubSpot version of jest/stripe/n-materialized-queries.test.js.
 * Materialized query lifecycle: create, status, list statuses, refresh, cancel.
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
const { runMaterializedQueries } = require("../../tests/hubspot/n-materialized-queries");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const gate = skipUnless(check, "N: Materialized Query Endpoints", "It materializes `contacts` as a fixture in a private catalog that C must not be reading from a parallel worker - and a private catalog needs its own connection.");
const maybeTest = gate.ok ? test : test.skip;
if (!gate.ok) console.warn(`Skipping ${gate.name}`);
maybeTest(
  gate.name,
  async () => {
    requireCredentials("hubspot");
    ctx = buildFreshCtx("hubspot");
    ctx.runTag = runTag();
    await withScenario("N: Materialized Query Endpoints", () => runMaterializedQueries(ctx));
  },
  300000
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
