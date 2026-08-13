/**
 * Peaka x Stripe Connector Test Suite
 * -------------------------------------
 * Three consolidated tests, one per category:
 *   B - Catalog & Schema Discovery
 *   C - Data Correctness & Cache Behavior
 *   F - Error Handling & Edge Cases
 *
 * A - Connection Setup used to live here too. It was merged into
 * `G: Connection Endpoints` (tests/stripe/g-connections.js) on 2026-07-31:
 * both scenarios covered connections, and A's "create a valid connection" step
 * asserted a strict subset of what G's first step already asserts. Only A's
 * invalid-token check was unique, so it moved to G and A was deleted.
 *
 * C was previously two tests (C: Data Correctness and D: Cache Behavior).
 * They were merged because they interacted: caching a table while the other
 * test queried it live made the live count return 0, since Peaka's query
 * routing prefers an existing cache even mid-sync. Keeping them separate
 * required D to deliberately avoid C's tables; merging removes the race
 * entirely and makes the live-vs-cached difference the point of the test.
 * See tests/stripe/c-data-and-cache.js for the full reasoning.
 *
 * Each test internally runs its own sequence of checks (see tests/*.js) -
 * e.g. B's steps have a real dependency chain (read catalog -> discover
 * schema -> discover tables -> check cache flags -> check columns), and C's
 * steps do too (measure uncached -> cache -> measure cached -> compare).
 * That ordering is just plain sequential `await` code inside one function,
 * not something Jest's scheduler needs to reason about.
 *
 * WHY test.concurrent() IS SAFE HERE (unlike an earlier version of this
 * suite that kept 21 separate scenarios): each of the 5 tests below builds
 * its OWN fresh ctx and touches only its own category's concerns - nothing
 * is shared or mutated across tests. Earlier, when B1-B4/D1-D6 were separate
 * `test()` calls needing to run in a specific order relative to each other,
 * we confirmed empirically that Jest's test.concurrent() does not reliably
 * preserve declaration order relative to other tests - which made it unsafe
 * for that shape of suite. Consolidating each category into one test removes
 * the cross-test ordering requirement entirely, so there's nothing left for
 * Jest's scheduler to get wrong.
 *
 * SETUP: .env needs PEAKA_API_KEY, PEAKA_PROJECT_ID, STRIPE_TEST_TOKEN,
 * PEAKA_CATALOG_ID, PEAKA_SCHEMA_NAME.
 *
 * RUN:
 *   npm test                 - run once
 *   npm test -- --watch      - watch mode
 *   npx jest --ci            - also writes junit.xml (see jest.config.js)
 *
 * CLEANUP: runs automatically in afterAll unless SKIP_CLEANUP=true is set.
 */

const { loadDotEnv, checkCredentials } = require("../../helpers/env");
const { PeakaClient } = require("../../helpers/peakaClient");
const { StripeClient } = require("../../helpers/stripeClient");
const { gateFor } = require("../../helpers/preflight");
const { cleanup } = require("../../helpers/cleanup");
const { withScenario } = require("../../helpers/stepReporter");
const { runCatalogSchemaDiscovery } = require("../../tests/stripe/b-catalog-schema");
const { runDataAndCache } = require("../../tests/stripe/c-data-and-cache");
const { runErrorHandling } = require("../../tests/stripe/f-error-handling");

loadDotEnv();

const check = checkCredentials();

function buildFreshCtx() {
  const {
    PEAKA_API_KEY: apiKey,
    PEAKA_PROJECT_ID: projectId,
    STRIPE_TEST_TOKEN: stripeToken,
    PEAKA_CATALOG_ID: catalogId,
    PEAKA_SCHEMA_NAME: schemaName,
  } = check.values;

  return {
    client: new PeakaClient({ apiKey, projectId }),
    // C compares Peaka's cached customer count against Stripe's own count
    // rather than against a number in .env, so it needs a Stripe client.
    stripe: new StripeClient({ token: stripeToken }),
    stripeToken,
    catalogId,
    catalogNameFromConfig: process.env.PEAKA_CATALOG_NAME || null,
    schemaName,
    // The confirmed ~100-row COUNT(*) cap, asserted as a PASSING regression
    // test (see tests/stripe/c-data-and-cache.js). A product constant, not
    // account data - which is why it stayed when NUM_CUSTOMERS was removed for
    // tying the suite to one person's Stripe account. Measured on all four
    // tables, not just customers.
    expectedCustomerCountNonCache: parseInt(process.env.EXPECTED_CUSTOMER_COUNT_NON_CACHE || "100", 10),
    createdConnectionIds: [],
    createdCatalogIds: [],
    createdCacheIds: [],
    createdQueryIds: [],
    createdInternalTableNames: [],
    createdBiTableNames: [],
    createdStripeCustomerIds: [],
  };
}

// One ctx per category, populated by that category's own test. Kept
// module-scoped (not shared between tests) purely so afterAll can clean up
// whatever each one created.
let ctxB = null;
let ctxC = null;
let ctxF = null;

function requireCredentials() {
  if (!check.ok) {
    throw new Error(`Credentials not configured:\n${check.errors.join("\n")}`);
  }
}

// B only reads metadata (schemas, tables, columns), so it needs no seeded
// rows and is deliberately ungated.
test.concurrent("B: Catalog & Schema Discovery", async () => {
  requireCredentials();
  ctxB = buildFreshCtx();
  await withScenario("B: Catalog & Schema Discovery", () => runCatalogSchemaDiscovery(ctxB));
});

// GATED. Every assertion in C is about row counts and distributions, so an
// empty catalog makes it meaningless rather than failing usefully. gateFor
// rather than gatedTest because these run concurrently - see helpers/preflight.js.
const gC = gateFor("C: Data Correctness & Cache Behavior", "stripe.customers");
(gC.ok ? test.concurrent : test.concurrent.skip)(
  gC.name,
  async () => {
    requireCredentials();
    ctxC = buildFreshCtx();
    await withScenario("C: Data Correctness & Cache Behavior", () => runDataAndCache(ctxC));
  },
  // Generous: this one runs every correctness check twice (uncached, then
  // cached) with four cache syncs in between. Measured ~2 min end to end -
  // the syncs are polled in parallel, so they cost the slowest (~50s) rather
  // than the sum, but pollCacheUntilComplete alone allows up to ~100s.
  300000
);

// GATED on refunds specifically: most of F is negative-path testing that needs
// no data, but its pagination step reads two pages of 20 from `refunds`. That
// step used to skip itself silently when the table was empty, passing while
// verifying nothing - the exact soft-pass this gate replaces.
const gF = gateFor("F: Error Handling & Edge Cases", "stripe.refunds");
(gF.ok ? test.concurrent : test.concurrent.skip)(gF.name, async () => {
  requireCredentials();
  ctxF = buildFreshCtx();
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
