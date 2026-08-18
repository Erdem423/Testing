/**
 * Tier 1 concurrency conflicts
 * ----------------------------
 * DELIBERATELY races cache operations against each other. See
 * CONCURRENCY-SPEC.md for the full conflict matrix and reasoning.
 *
 * ISOLATED ON PURPOSE. This lives in jest/races/, which jest.config.js
 * excludes, and runs only under `npm run test:races`. Two reasons:
 *
 *   1. It manufactures races. Running it beside the main suite would create
 *      UNINTENDED ones and produce failures that look like code regressions -
 *      not hypothetical: a stray dashboard server running a second suite
 *      against the same project once caused a 3x slowdown and four spurious
 *      failures during development.
 *   2. It caches `customers`, which C also caches. Overlapping those two is
 *      exactly the interference that forced the C/D merge.
 *
 * Also runs SEQUENTIALLY (one test, plain `test()`), because every step here
 * competes for the same table.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gateFor, skipUnless } = require("../../helpers/preflight");
const { checkWithToken } = require("../../tests/stripe/checkTokenCredentials");
const { assertSafeToRaceOrThrow } = require("../../helpers/racePreflight");
const { runTier1Races } = require("../../tests/races/tier1");

// GATED like every other Stripe-dependent scenario: these cache `customers`,
// so without Stripe credentials there is nothing to race against and the
// tier must SKIP rather than throw. The beforeAll below is guarded too -
// it performs live API calls that would fail the same way.
// TWO WAYS TO SKIP, and they mean different things. The preflight gate is
// "no data to race against"; the token check is "no key to build the
// connection this tier races on". STRIPE_TEST_TOKEN left the connector's
// requiredEnv so the six Peaka-only Stripe scenarios could run without one
// (see tests/stripe/config.js) - which means these tiers, which do need it,
// now have to say so themselves.
const tokenCheck = checkWithToken();
const gate = tokenCheck.ok
  ? gateFor("RACE-T1: Cache operation conflicts", "stripe.customers")
  : skipUnless(tokenCheck, "RACE-T1: Cache operation conflicts", "Every tier provisions its own Stripe connection and catalog to race against, so it cannot start without a key to create them.");

let ctx = null;

// Fail fast if another run looks active - see helpers/racePreflight.js. These
// tests manufacture races, so overlapping them with anything else produces
// failures that look like regressions but are not. That has happened twice.
beforeAll(async () => {
  if (!gate.ok) return; // scenario is skipped - nothing to guard
  requireCredentials();
  await assertSafeToRaceOrThrow(buildFreshCtx().client, (line) => console.log(line));
}, 30000);

(gate.ok ? test : test.skip)(
  gate.name,
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("RACE-T1: Cache operation conflicts", () => runTier1Races(ctx));
  },
  // Generous: each step creates a fresh cache on a ~37s-syncing table and
  // waits for it to settle afterwards.
  600000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // Teardown matters more here than anywhere else - the point of these tests
  // is to leave resources in strange states, and a mid-sync resource may
  // refuse deletion on the first attempt. cleanup() is already per-item
  // best-effort; anything it cannot remove gets reported loudly below rather
  // than swallowed, because an orphan needs manual attention.
  const outcomes = await cleanup(ctx, (line) => console.log(line));
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) {
    console.log(
      `\n⚠ ${failed.length} resource(s) could not be deleted and need MANUAL cleanup:\n` +
        failed.map((f) => `   ${f.type} ${f.id} (status ${f.status || "threw"})`).join("\n")
    );
  }
}, 180000);
