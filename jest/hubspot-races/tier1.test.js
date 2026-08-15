/**
 * Tier 1 concurrency conflicts (HubSpot)
 * ----------------------------------------
 * HubSpot version of jest/races/tier1.test.js. See CONCURRENCY-SPEC.md for
 * the design and tests/hubspot-races/tier1.js's header comment for how this
 * differs from the Stripe version's certainty level.
 *
 * ISOLATED ON PURPOSE, same as the Stripe races: excluded from
 * jest.config.js, runs only under `npm run test:races`.
 */
const {
  buildFreshCtx,
  requireCredentials,
  runTag,
  credentialCheck: check,
} = require("../../helpers/buildCtx")("hubspot");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { assertSafeToRaceOrThrow } = require("../../helpers/racePreflight");
const { runTier1Races } = require("../../tests/hubspot-races/tier1");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const maybeTest = check.ok ? test : test.skip;
if (!check.ok) console.warn(`Skipping HubSpot RACE-T1 - credentials not configured:\n${check.errors.join("\n")}`);

beforeAll(async () => {
  if (!check.ok) return;
  requireCredentials();
  await assertSafeToRaceOrThrow(buildFreshCtx().client, (line) => console.log(line));
}, 30000);

maybeTest(
  "RACE-T1: Cache operation conflicts",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("RACE-T1: Cache operation conflicts", () => runTier1Races(ctx));
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
