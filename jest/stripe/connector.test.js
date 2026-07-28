/**
 * Peaka x Stripe Connector Test Suite
 * -------------------------------------
 * Five consolidated tests, one per category:
 *   A - Connection Setup
 *   B - Catalog & Schema Discovery
 *   C - Data Correctness
 *   D - Cache Behavior
 *   F - Error Handling & Edge Cases
 *
 * Each test internally runs its own sequence of checks (see tests/*.js) -
 * e.g. B's steps have a real dependency chain (read catalog -> discover
 * schema -> discover tables -> check cache flags -> check columns), and D's
 * steps do too (create cache -> poll status -> ...). That ordering is just
 * plain sequential `await` code inside one function, not something Jest's
 * scheduler needs to reason about.
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
 * PEAKA_CATALOG_ID, PEAKA_SCHEMA_NAME, optionally NUM_CUSTOMERS.
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
const { cleanup } = require("../../helpers/cleanup");
const { runConnectionSetup } = require("../../tests/stripe/a-connection-setup");
const { runCatalogSchemaDiscovery } = require("../../tests/stripe/b-catalog-schema");
const { runDataCorrectness } = require("../../tests/stripe/c-data-correctness");
const { runCacheBehavior } = require("../../tests/stripe/d-cache-behavior");
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
    stripeToken,
    catalogId,
    catalogNameFromConfig: process.env.PEAKA_CATALOG_NAME || null,
    schemaName,
    expectedCustomerCount: parseInt(process.env.NUM_CUSTOMERS || "500", 10),
    // Deliberately a SEPARATE env var from NUM_CUSTOMERS, not another parse
    // of the same one - this is what C's live (uncached) count check now
    // asserts against, as a passing regression test for the confirmed
    // ~100-row COUNT(*) cap (see tests/stripe/c-data-correctness.js), rather
    // than the real customer count.
    expectedCustomerCountNonCache: parseInt(process.env.EXPECTED_CUSTOMER_COUNT_NON_CACHE || "100", 10),
    createdConnectionIds: [],
    createdCatalogIds: [],
    createdCacheIds: [],
  };
}

// One ctx per category, populated by that category's own test. Kept
// module-scoped (not shared between tests) purely so afterAll can clean up
// whatever each one created.
let ctxA = null;
let ctxB = null;
let ctxC = null;
let ctxD = null;
let ctxF = null;

function requireCredentials() {
  if (!check.ok) {
    throw new Error(`Credentials not configured:\n${check.errors.join("\n")}`);
  }
}

test.concurrent("A: Connection Setup", async () => {
  requireCredentials();
  ctxA = buildFreshCtx();
  await runConnectionSetup(ctxA);
});

test.concurrent("B: Catalog & Schema Discovery", async () => {
  requireCredentials();
  ctxB = buildFreshCtx();
  await runCatalogSchemaDiscovery(ctxB);
});

test.concurrent(
  "C: Data Correctness",
  async () => {
    requireCredentials();
    ctxC = buildFreshCtx();
    await runDataCorrectness(ctxC);
  },
  120000 // generous timeout - "customer count via completed cache" polls a cache to completion, same as D, can take up to ~100s
);

test.concurrent(
  "D: Cache Behavior",
  async () => {
    requireCredentials();
    ctxD = buildFreshCtx();
    await runCacheBehavior(ctxD);
  },
  120000 // generous timeout - the status-polling step alone can take up to ~100s
);

test.concurrent("F: Error Handling & Edge Cases", async () => {
  requireCredentials();
  ctxF = buildFreshCtx();
  await runErrorHandling(ctxF);
});

afterAll(async () => {
  const allCtxs = [ctxA, ctxB, ctxC, ctxD, ctxF].filter(Boolean);
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
