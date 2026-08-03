const { loadDotEnv, checkCredentials } = require("./env");
const { PeakaClient } = require("./peakaClient");
const { StripeClient } = require("./stripeClient");

/**
 * Shared test-context builder.
 *
 * Extracted from jest/stripe/connector.test.js once the suite grew past one
 * test file: every scenario file needs the same fresh ctx, and copying the
 * builder into each one is exactly how it drifts.
 *
 * Each call returns a COMPLETELY fresh ctx - its own PeakaClient and its own
 * empty tracking arrays. Nothing is shared between scenarios, which is what
 * makes them safe to run in parallel across Jest workers (and what made
 * test.concurrent() safe in connector.test.js before that).
 */
loadDotEnv();

const check = checkCredentials();

/** Throws with all missing/placeholder credentials listed, if any. */
function requireCredentials() {
  if (!check.ok) {
    throw new Error(`Credentials not configured:\n${check.errors.join("\n")}`);
  }
}

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
    // The ONLY client that talks to Stripe directly. Used by o-data-freshness
    // to add a row at the source; everything else reads through Peaka.
    stripe: new StripeClient({ token: stripeToken }),
    projectId,
    stripeToken,
    catalogId,
    catalogNameFromConfig: process.env.PEAKA_CATALOG_NAME || null,
    schemaName,
    expectedCustomerCount: parseInt(process.env.NUM_CUSTOMERS || "500", 10),
    expectedCustomerCountNonCache: parseInt(process.env.EXPECTED_CUSTOMER_COUNT_NON_CACHE || "100", 10),
    // Only ever populated with resources the run itself created - cleanup.js
    // deletes exactly these and nothing else. The project contains unrelated
    // pre-existing connections, queries and tables that must be left alone.
    createdConnectionIds: [],
    createdCatalogIds: [],
    createdCacheIds: [],
    createdQueryIds: [],
    createdInternalTableNames: [],
    // UPSTREAM resources, not Peaka ones. A leftover customer permanently
    // shifts the counts C asserts against, so cleanup deletes these first.
    createdStripeCustomerIds: [],
  };
}

/**
 * A unique-ish suffix for resource names, so parallel scenario files never
 * collide on a name and leftovers are traceable to a run.
 */
function runTag() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

module.exports = { buildFreshCtx, requireCredentials, runTag, credentialCheck: check };
