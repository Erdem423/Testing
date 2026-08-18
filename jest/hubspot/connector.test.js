/**
 * Peaka x HubSpot Connector Test Suite
 * ------------------------------------
 * HubSpot version of jest/stripe/connector.test.js - same three consolidated
 * tests (B/C/F), same test.concurrent() safety reasoning (each builds its own
 * fresh ctx, nothing shared - see the Stripe file's module comment for the
 * full "why test.concurrent() is safe here" writeup, which applies verbatim).
 *
 * DIFFERENCE FROM STRIPE: uses the pre-existing HubSpot connection+catalog
 * already set up in Peaka Studio (same project as Stripe's), scoped to the
 * "crm" schema. See tests/hubspot/c-data-and-cache.js for what's still
 * unconfirmed about HubSpot's actual data-cap/business-logic behavior.
 *
 * SETUP: .env needs PEAKA_API_KEY, PEAKA_PROJECT_ID, PEAKA_HUBSPOT_CATALOG_ID,
 * PEAKA_HUBSPOT_SCHEMA_NAME, optionally NUM_CONTACTS. HUBSPOT_ACCESS_TOKEN is
 * NOT required here (buildCtx is called with { requireToken: false }) - B/C/F
 * only read the pre-existing catalog above, they never call createConnection.
 * Unlike Stripe's B/C/F (which still require STRIPE_TEST_TOKEN even though
 * they don't use it, for consistency with G-N), this one's relaxed on
 * purpose: a HubSpot credential requires a HubSpot account, which not
 * everyone running this suite has, and there's no reason to block scenarios
 * that don't need one.
 *
 * RUN:
 *   npm test                 - run once (runs alongside the Stripe suite)
 *   npx jest -t "B: Catalog" - run one scenario
 *
 * CLEANUP: runs automatically in afterAll unless SKIP_CLEANUP=true is set.
 */

const { cleanup } = require("../../helpers/cleanup");
const { skipUnless } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { runCatalogSchemaDiscovery } = require("../../tests/hubspot/b-catalog-schema");
const { runDataAndCache } = require("../../tests/hubspot/c-data-and-cache");
const { runErrorHandling } = require("../../tests/hubspot/f-error-handling");
// requireToken: false - B/C/F only read the pre-existing HubSpot catalog,
// they never call createConnection, so HUBSPOT_ACCESS_TOKEN isn't needed
// here even though it's required for G/H/L/M/N (see helpers/env.js).
const { buildFreshCtx, requireCredentials, checkFor } = require("../../helpers/buildCtx");
const check = checkFor("hubspot");

// One ctx per category, populated by that category's own test. Kept
// module-scoped (not shared between tests) purely so afterAll can clean up
// whatever each one created.
let ctxB = null;
let ctxC = null;
let ctxF = null;

// SKIP, not FAIL, when credentials are missing/placeholder - see
// helpers/env.js. This is expected to be the normal state until
// HUBSPOT_ACCESS_TOKEN / PEAKA_HUBSPOT_CATALOG_ID / PEAKA_HUBSPOT_SCHEMA_NAME
// are added to .env.
// Each carries its OWN reason. A bare test.concurrent.skip puts the reason in
// the console and nowhere the dashboard can reach - jest/browserReporter.js
// recovers a skip reason by parsing SKIP_MARKER off the test title, so these
// three were the last scenarios in the suite still rendering as "skipped"
// with no explanation at all. See helpers/preflight.js's skipUnless().
const WHY =
  "All three read the pre-existing HubSpot catalog through Peaka - they need its id and schema, but no HubSpot token.";
const gates = {
  B: skipUnless(check, "B: Catalog & Schema Discovery", WHY),
  C: skipUnless(check, "C: Data Correctness & Cache Behavior", WHY),
  F: skipUnless(check, "F: Error Handling & Edge Cases", WHY),
};
const runner = (gate) => (gate.ok ? test.concurrent : test.concurrent.skip);

runner(gates.B)(gates.B.name, async () => {
  requireCredentials("hubspot");
  ctxB = buildFreshCtx("hubspot");
  await withScenario("B: Catalog & Schema Discovery", () => runCatalogSchemaDiscovery(ctxB));
});

runner(gates.C)(
  gates.C.name,
  async () => {
    requireCredentials("hubspot");
    ctxC = buildFreshCtx("hubspot");
    await withScenario("C: Data Correctness & Cache Behavior", () => runDataAndCache(ctxC));
  },
  // Generous, same reasoning as Stripe's: this caches 3 tables and waits for
  // them to sync. HubSpot sync duration isn't measured yet, so this leans on
  // the same timeout budget as Stripe's until real timings are known.
  300000
);

runner(gates.F)(gates.F.name, async () => {
  requireCredentials("hubspot");
  ctxF = buildFreshCtx("hubspot");
  await withScenario("F: Error Handling & Edge Cases", () => runErrorHandling(ctxF));
});

afterAll(async () => {
  const allCtxs = [ctxB, ctxC, ctxF].filter(Boolean);
  if (allCtxs.length === 0) return;

  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }

  for (const ctx of allCtxs) {
    const hasResources =
      ctx.createdCacheIds.length > 0 || ctx.createdCatalogIds.length > 0 || ctx.createdConnectionIds.length > 0;
    if (!hasResources) continue;
    await cleanup(ctx, (line) => console.log(line));
  }
}, 60000);
