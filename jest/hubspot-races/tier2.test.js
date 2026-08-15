/**
 * Tier 2 concurrency conflicts (HubSpot)
 * ----------------------------------------
 * HubSpot version of jest/races/tier2.test.js. See CONCURRENCY-SPEC.md and
 * tests/hubspot-races/tier2.js's header comment.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { checkWithToken } = require("../../tests/hubspot/checkTokenCredentials");
const check = checkWithToken();
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { assertSafeToRaceOrThrow } = require("../../helpers/racePreflight");
const { runTier2Races } = require("../../tests/hubspot-races/tier2");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const maybeTest = check.ok ? test : test.skip;
if (!check.ok) console.warn(`Skipping HubSpot RACE-T2 - credentials not configured:\n${check.errors.join("\n")}`);

beforeAll(async () => {
  if (!check.ok) return;
  requireCredentials("hubspot");
  await assertSafeToRaceOrThrow(buildFreshCtx("hubspot").client, (line) => console.log(line));
}, 30000);

maybeTest(
  "RACE-T2: Cross-resource conflicts",
  async () => {
    requireCredentials("hubspot");
    ctx = buildFreshCtx("hubspot");
    ctx.runTag = runTag();
    await withScenario("RACE-T2: Cross-resource conflicts", () => runTier2Races(ctx));
  },
  600000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  const outcomes = await cleanup(ctx, (line) => console.log(line));
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) {
    console.log(
      `\n⚠ ${failed.length} resource(s) could not be deleted and need MANUAL cleanup:\n` +
        failed.map((f) => `   ${f.type} ${f.id} (status ${f.status || "threw"})`).join("\n")
    );
  }
}, 180000);
