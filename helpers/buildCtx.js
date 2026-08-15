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

// Per-connector and cached, so a folder is validated once however many
// scenario files it has.
const checks = {};
function checkFor(connectorId) {
  if (!checks[connectorId]) checks[connectorId] = checkCredentials(connectorId);
  return checks[connectorId];
}

/**
 * Throws with all missing/placeholder credentials listed, if any.
 *
 * Takes a connector id so a missing STRIPE_TEST_TOKEN cannot fail a Postgres
 * run, and vice versa - see helpers/env.js.
 */
function requireCredentials(connectorId = "stripe") {
  const check = checkFor(connectorId);
  if (!check.ok) {
    throw new Error(`Credentials not configured for '${connectorId}':\n${check.errors.join("\n")}`);
  }
}

/**
 * Builds a fresh ctx for one connector.
 *
 * DEFAULTS TO "stripe" on purpose. All ten existing Stripe test files call this
 * with no argument and must keep working untouched - the refactor that made a
 * second connector possible should not be visible to the first one.
 */
function buildFreshCtx(connectorId = "stripe") {
  const check = checkFor(connectorId);
  const config = check.config || {};
  // Callers are supposed to call requireCredentials() first, but if one
  // forgets, say so plainly instead of throwing a TypeError on `check.values`
  // being undefined - which is what this did the first time a connector was
  // added without its env vars set.
  if (!check.ok) {
    throw new Error(`Credentials not configured for '${connectorId}':\n${check.errors.join("\n")}`);
  }
  const { PEAKA_API_KEY: apiKey, PEAKA_PROJECT_ID: projectId } = check.values;

  // Which env var holds the catalog and schema is config-driven, so two
  // connectors can point at different catalogs in the same project.
  const catalogId = check.values[config.catalogIdEnv || "PEAKA_CATALOG_ID"];
  const schemaName = check.values[config.schemaEnv || "PEAKA_SCHEMA_NAME"];
  const stripeToken = check.values.STRIPE_TEST_TOKEN;

  return {
    connectorId,
    connectorConfig: config,
    client: new PeakaClient({ apiKey, projectId }),
    // Built ONLY for connectors that declare it. It is the one client that
    // writes to an upstream system, so a Postgres run should not carry it.
    stripe: config.usesStripeClient ? new StripeClient({ token: stripeToken }) : null,
    projectId,
    stripeToken,
    // Generic credential slot Stripe's own scenario files read directly
    // (tests/stripe/g-connections.js etc. use `credential: { token: ctx.token }`).
    // Stripe's own STRIPE_TEST_TOKEN wins when present; otherwise falls back
    // to whatever tokenEnv the connector declares (e.g. HubSpot's
    // HUBSPOT_ACCESS_TOKEN, see tests/hubspot/config.js) - null for
    // connectors that need neither (Postgres/Mongo reuse an existing
    // connection instead of authenticating one themselves here).
    token: stripeToken || (config.tokenEnv ? process.env[config.tokenEnv] || null : null),
    catalogId,
    // Reused rather than created - see tests/postgres/config.js for why.
    connectionId: config.connectionIdEnv ? process.env[config.connectionIdEnv] || null : null,
    catalogNameFromConfig: process.env[config.catalogNameEnv || "PEAKA_CATALOG_NAME"] || null,
    schemaName,
    // NOTE: there is deliberately no `expectedCustomerCount` here any more.
    // It came from NUM_CUSTOMERS in .env, which tied the suite to one person's
    // Stripe account. C now asks Stripe itself - see stripeClient.countCustomers().
    expectedCustomerCountNonCache:
      config.expectedCounts && config.expectedCounts.liveCap
        ? config.expectedCounts.liveCap()
        : parseInt(process.env.EXPECTED_CUSTOMER_COUNT_NON_CACHE || "100", 10),
    // Only ever populated with resources the run itself created - cleanup.js
    // deletes exactly these and nothing else. The project contains unrelated
    // pre-existing connections, queries and tables that must be left alone.
    createdConnectionIds: [],
    createdCatalogIds: [],
    createdCacheIds: [],
    createdQueryIds: [],
    // Moving a query to a new path creates a folder that OUTLIVES the query,
    // so folders need tracking of their own - deleting the query is not enough.
    createdQueryFolderIds: [],
    createdInternalTableNames: [],
    createdBiTableNames: [],
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

module.exports = { buildFreshCtx, requireCredentials, runTag, checkFor, credentialCheck: checkFor("stripe") };
