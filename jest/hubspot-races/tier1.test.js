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
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { skipUnless } = require("../../helpers/preflight");
const { checkWithToken } = require("../../tests/hubspot/checkTokenCredentials");
const check = checkWithToken();
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { assertSafeToRaceOrThrow } = require("../../helpers/racePreflight");
const { runTier1Races } = require("../../tests/hubspot-races/tier1");

let ctx = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see helpers/env.js.
const gate = skipUnless(check, "RACE-T1: Cache operation conflicts", "Every race tier drives its own throwaway connection and catalog concurrently, so it needs a token to create them.");
const maybeTest = gate.ok ? test : test.skip;
if (!gate.ok) console.warn(`Skipping ${gate.name}`);
beforeAll(async () => {
  if (!check.ok) return;
  requireCredentials("hubspot");
  await assertSafeToRaceOrThrow(buildFreshCtx("hubspot").client, (line) => console.log(line));
}, 30000);

maybeTest(
  gate.name,
  async () => {
    requireCredentials("hubspot");
    ctx = buildFreshCtx("hubspot");
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
