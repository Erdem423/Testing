/**
 * J: Internal Table Endpoints
 * ---------------------------
 * Peaka internal table and column CRUD. Project-level, no catalog needed.
 *
 * Runs in its OWN file so Jest schedules it in a separate worker process,
 * genuinely in parallel with the other scenarios rather than interleaved on
 * one worker the way test.concurrent() works. Each file builds its own ctx
 * (helpers/buildCtx.js) and cleans up after itself, so nothing is shared.
 */
const {
  buildFreshCtx,
  requireCredentials,
  runTag,
  credentialCheck: check,
} = require("../../helpers/buildCtx")("stripe");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runInternalTables } = require("../../tests/stripe/j-internal-tables");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const maybeTest = check.ok ? test : test.skip;
if (!check.ok) console.warn(`Skipping J: Internal Table Endpoints - credentials not configured:\n${check.errors.join("\n")}`);

maybeTest(
  "J: Internal Table Endpoints",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("J: Internal Table Endpoints", () => runInternalTables(ctx));
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
