const { loadDotEnv, checkCredentials, CONNECTOR_SPECS } = require("./env");
const { PeakaClient } = require("./peakaClient");

/**
 * Shared test-context builder factory - one call per connector, e.g.
 *   const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx")("stripe");
 *   const { buildFreshCtx, ... } = require("../../helpers/buildCtx")("hubspot", { requireToken: false });
 *
 * Extracted from jest/stripe/connector.test.js once the suite grew past one
 * test file: every scenario file needs the same fresh ctx, and copying the
 * builder into each one is exactly how it drifts. Parameterized by
 * connectorId (not a plugin registry - see CONNECTOR_SPECS in helpers/env.js)
 * so the same builder serves both "stripe" and "hubspot" without duplicating
 * this file per connector.
 *
 * `options` is forwarded to checkCredentials() as-is - currently only
 * { requireToken: false } is used, by scenarios that only ever read a
 * pre-existing catalog and never call createConnection (see checkCredentials'
 * own doc comment in helpers/env.js for why this exists).
 *
 * Each buildFreshCtx() call returns a COMPLETELY fresh ctx - its own
 * PeakaClient and its own empty tracking arrays. Nothing is shared between
 * scenarios, which is what makes them safe to run in parallel across Jest
 * workers (and what made test.concurrent() safe in connector.test.js).
 */
loadDotEnv();

function createCtxBuilder(connectorId = "stripe", options = {}) {
  const spec = CONNECTOR_SPECS[connectorId];
  const check = checkCredentials(connectorId, options);

  /** Throws with all missing/placeholder credentials listed, if any. */
  function requireCredentials() {
    if (!check.ok) {
      throw new Error(`Credentials not configured for "${connectorId}":\n${check.errors.join("\n")}`);
    }
  }

  function buildFreshCtx() {
    const apiKey = check.values.PEAKA_API_KEY;
    const projectId = check.values.PEAKA_PROJECT_ID;
    const token = check.values[spec.tokenVar];
    const catalogId = check.values[spec.catalogIdVar];
    const schemaName = check.values[spec.schemaNameVar];

    return {
      client: new PeakaClient({ apiKey, projectId }),
      projectId,
      connectorType: connectorId,
      token,
      catalogId,
      catalogNameFromConfig: process.env[spec.catalogNameVar] || null,
      schemaName,
      expectedCustomerCount: parseInt(process.env[spec.countVar] || String(spec.countDefault), 10),
      expectedCustomerCountNonCache: parseInt(process.env[spec.countCapVar] || String(spec.countCapDefault), 10),
      // Only ever populated with resources the run itself created - cleanup.js
      // deletes exactly these and nothing else. The project contains unrelated
      // pre-existing connections, queries and tables that must be left alone.
      createdConnectionIds: [],
      createdCatalogIds: [],
      createdCacheIds: [],
      createdQueryIds: [],
      createdInternalTableNames: [],
    };
  }

  return { buildFreshCtx, requireCredentials, runTag, credentialCheck: check };
}

/**
 * A unique-ish suffix for resource names, so parallel scenario files never
 * collide on a name and leftovers are traceable to a run.
 */
function runTag() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

module.exports = createCtxBuilder;
