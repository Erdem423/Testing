/**
 * Runtime configuration for the Stripe connector folder.
 *
 * DELIBERATELY SEPARATE FROM meta.js. That file is display metadata the
 * dashboard reads on every request; this one is read by helpers/buildCtx.js
 * when a test builds its context. Keeping them apart means a malformed config
 * can never break the dashboard's folder discovery, and vice versa.
 *
 * Adding a connector means adding one of these next to a meta.js - see
 * tests/postgres/config.js for the second one, which is what finally tested
 * the repo's long-standing "a new connector needs zero core changes" claim.
 */
module.exports = {
  // Checked by helpers/env.js on top of the core credentials every connector
  // needs (PEAKA_API_KEY, PEAKA_PROJECT_ID).
  requiredEnv: ["STRIPE_TEST_TOKEN", "PEAKA_CATALOG_ID", "PEAKA_SCHEMA_NAME"],

  catalogIdEnv: "PEAKA_CATALOG_ID",
  schemaEnv: "PEAKA_SCHEMA_NAME",
  catalogNameEnv: "PEAKA_CATALOG_NAME",

  // Stripe is an API connector, so Peaka caches it to escape the upstream
  // pagination. That is why the cache scenarios and all four race tiers exist
  // here and cannot exist for a database connector.
  supportsCaching: true,

  // The Stripe client is only built for this connector - it is the one place
  // the suite writes to an upstream system (scenario O).
  usesStripeClient: true,

  expectedCounts: {
    // The confirmed live-query cap. A deliberate PASSING regression test -
    // see FINDINGS.md; do not raise this to match a real count.
    //
    // This is a PRODUCT CONSTANT, not account data, which is why it survived
    // the portability pass that deleted NUM_CUSTOMERS. The real customer count
    // is now asked of Stripe directly - see helpers/stripeClient.js's
    // countCustomers() and the cached-count step in c-data-and-cache.js.
    liveCap: () => parseInt(process.env.EXPECTED_CUSTOMER_COUNT_NON_CACHE || "100", 10),
  },
};
