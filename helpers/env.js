const fs = require("fs");
const path = require("path");

/**
 * Minimal .env loader - no `dotenv` package needed.
 * Reads KEY=VALUE lines from .env (in the project root), skips blank lines
 * and lines starting with #, strips surrounding quotes, and only sets a
 * variable if it isn't already set in the real environment (so `export
 * FOO=bar node run.js` still overrides whatever is in .env).
 */
function loadDotEnv(envPath = path.join(__dirname, "..", ".env")) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Kept in sync with the README's Setup block - these are the literal strings a
// reader copies out of it, so a run against an unedited .env fails with "still
// set to its placeholder" rather than a confusing auth error.
const PLACEHOLDER_VALUES = new Set([
  "your_peaka_partner_api_key",
  "your_peaka_project_id",
  "sk_test_your_stripe_test_key",
  "your_existing_peaka_catalog_id",
  "your_peaka_schema_name",
  "your_postgres_catalog_id",
  "your_postgres_connection_id",
]);

/**
 * Validates that all required credentials are set and non-placeholder.
 * Returns { ok: true, values: {...} } or { ok: false, errors: string[] }.
 * Never throws - callers (CLI or server) decide how to surface errors.
 *
 * PEAKA_CATALOG_NAME is intentionally NOT required here - it's an optional
 * fallback (see .env) only needed if the getCatalog API call can't
 * auto-discover the catalog's queryable name/slug. Read it directly from
 * process.env where ctx is built, not through this required-credential check.
 *
 * PEAKA_SCHEMA_NAME IS required - unlike catalogName, this is used directly
 * by nearly every scenario (B2-B4, C, D, F) as a config value rather than
 * something discovered at runtime, so there's no live-lookup fallback for it.
 */
// Needed by EVERY connector - these address the Peaka project itself rather
// than any particular data source.
const CORE_REQUIRED = ["PEAKA_API_KEY", "PEAKA_PROJECT_ID"];

/**
 * Loads a connector folder's runtime config (tests/<id>/config.js).
 *
 * Returns null for a folder without one, so a connector can exist with only a
 * meta.js if it needs no settings of its own.
 */
function loadConnectorConfig(connectorId) {
  try {
    return require(`../tests/${connectorId}/config`);
  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") return null;
    throw err;
  }
}

/**
 * Validates the credentials for ONE connector.
 *
 * Used to require STRIPE_TEST_TOKEN of everybody, which made the suite
 * unrunnable for any connector that has no Stripe key - the thing that stopped
 * the "a new connector needs zero core changes" claim from being true. The
 * per-connector half now comes from tests/<id>/config.js's requiredEnv.
 */
function checkCredentials(connectorId = "stripe") {
  const errors = [];
  const values = {};
  const config = loadConnectorConfig(connectorId);

  const required = [...CORE_REQUIRED, ...((config && config.requiredEnv) || [])];

  for (const name of required) {
    const val = process.env[name];
    if (!val) {
      errors.push(`Missing ${name}. Set it in .env or export it in your shell.`);
      continue;
    }
    if (PLACEHOLDER_VALUES.has(val)) {
      errors.push(`${name} is still set to its placeholder value. Edit .env and fill in your real value.`);
      continue;
    }
    values[name] = val;
  }

  // Stripe-specific and stays that way: this client can create and delete real
  // customers, so a live key must never reach it.
  if (values.STRIPE_TEST_TOKEN && !values.STRIPE_TEST_TOKEN.startsWith("sk_test_")) {
    errors.push("STRIPE_TEST_TOKEN must be a Stripe TEST key (sk_test_...). Refusing to run against a live key.");
  }

  return errors.length > 0 ? { ok: false, errors, config } : { ok: true, values, config };
}

module.exports = { loadDotEnv, checkCredentials, loadConnectorConfig, PLACEHOLDER_VALUES, CORE_REQUIRED };
