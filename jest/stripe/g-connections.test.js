/**
 * G: Connection Endpoints
 * -----------------------
 * Connection lifecycle plus the connector-config catalogue. Creates and
 * deletes its own connection; never touches the one behind PEAKA_CATALOG_ID.
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
const { runConnections } = require("../../tests/stripe/g-connections");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const maybeTest = check.ok ? test : test.skip;
if (!check.ok) console.warn(`Skipping G: Connection Endpoints - credentials not configured:\n${check.errors.join("\n")}`);

maybeTest(
  "G: Connection Endpoints",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("G: Connection Endpoints", () => runConnections(ctx));
  },
  120000
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
