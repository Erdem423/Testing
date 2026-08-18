/**
 * Tier 4 - races that persist wrong data
 * --------------------------------------
 * Where Tiers 1-3 ask "does it error, or wedge?", this asks whether the API
 * silently writes something WRONG down and keeps it. See CONCURRENCY-SPEC.md.
 *
 * ISOLATED ON PURPOSE, like the other tiers: lives in jest/races/, which
 * jest.config.js excludes, and runs only under `npm run test:races`.
 *
 * THIS TIER WRITES TO STRIPE. It creates one customer during a cache sync to
 * test whether a row written mid-sync can be permanently lost. The id is tracked
 * on ctx.createdStripeCustomerIds the instant it exists, and helpers/cleanup.js
 * deletes Stripe customers FIRST, before any Peaka resource - a leftover
 * customer would permanently shift the row counts scenario C asserts against.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gateFor, skipUnless } = require("../../helpers/preflight");
const { checkWithToken } = require("../../tests/stripe/checkTokenCredentials");
const { assertSafeToRaceOrThrow } = require("../../helpers/racePreflight");
const { runTier4Races } = require("../../tests/races/tier4");

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
  ? gateFor("RACE-T4: Durable artifacts built mid-sync", "stripe.customers")
  : skipUnless(tokenCheck, "RACE-T4: Durable artifacts built mid-sync", "It WRITES to Stripe while a cache refreshes, so it needs the key both to create its connection and to make the change it is racing.");

let ctx = null;

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
    await withScenario("RACE-T4: Durable artifacts built mid-sync", () => runTier4Races(ctx));
  },
  // One ~37s sync, plus an export poll and up to two follow-up refreshes if the
  // mid-sync row does not appear straight away.
  600000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    if (ctx.createdStripeCustomerIds && ctx.createdStripeCustomerIds.length > 0) {
      console.log(
        `⚠ SKIP_CLEANUP left ${ctx.createdStripeCustomerIds.length} Stripe customer(s) behind: ` +
          `${ctx.createdStripeCustomerIds.join(", ")}. Delete them, or the counts C asserts against shift.`
      );
    }
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // Same reasoning as the other tiers: the point of these tests is to leave
  // resources in strange states, so anything cleanup cannot remove is reported
  // loudly rather than swallowed.
  const outcomes = await cleanup(ctx, (line) => console.log(line));
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) {
    console.log(
      `\n⚠ ${failed.length} resource(s) could not be deleted and need MANUAL cleanup:\n` +
        failed.map((f) => `   ${f.type} ${f.id} (status ${f.status || "threw"})`).join("\n")
    );
  }
}, 180000);
