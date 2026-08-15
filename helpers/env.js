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

const PLACEHOLDER_VALUES = new Set([
  "your_peaka_partner_api_key",
  "your_peaka_project_id",
  "sk_test_your_stripe_test_key",
  "your_existing_peaka_catalog_id",
  "your_peaka_schema_name",
  "your_hubspot_access_token",
  "your_hubspot_private_app_token",
  "your_existing_hubspot_catalog_id",
]);

/**
 * Per-connector credential requirements. Only two entries on purpose - this
 * is not a plugin registry, just enough indirection that checkCredentials()
 * doesn't have to hardcode "stripe" everywhere. Add a third connector by
 * adding a third entry, not by generalizing the shape further.
 *
 * tokenPrefixes is null for hubspot because its credential shape is NOT a
 * prefixed bearer token like Stripe's sk_test_.../rk_test_... - confirmed via
 * a real getConnectionConfig("hubspot") call (2026-08-06): HubSpot connections
 * in Peaka are OAuth2 (authorizationType: "oauth2"), with credential fields
 * accessToken/refreshToken/clientId/clientSecret/redirectUrl, all marked
 * non-required by that config but in practice at least accessToken is needed
 * to authenticate. HUBSPOT_ACCESS_TOKEN here holds whatever single token value
 * ends up working - a HubSpot Private App token is the most likely candidate
 * (long-lived, usable as an access token without a full OAuth redirect
 * handshake) but this has not yet been confirmed to be ACCEPTED by Peaka,
 * only that the field name it maps to (accessToken) is correct. See
 * tests/hubspot/g-connections.js's credential: { accessToken: ctx.token }.
 */
const CONNECTOR_SPECS = {
  stripe: {
    tokenVar: "STRIPE_TEST_TOKEN",
    catalogIdVar: "PEAKA_CATALOG_ID",
    schemaNameVar: "PEAKA_SCHEMA_NAME",
    catalogNameVar: "PEAKA_CATALOG_NAME",
    // Stripe test-mode secret keys are sk_test_...; test-mode RESTRICTED keys
    // (scoped to specific permissions, e.g. read-only on customers/charges/
    // subscriptions/invoices) are rk_test_.... Both are valid here - Peaka's
    // Stripe connector doesn't care which shape it's given, and a restricted
    // key is the more secure choice. tests/stripe/g-connections.js's
    // credential-masking check already scans for both sk_/rk_ prefixes; this
    // list is what that check was implicitly assuming.
    tokenPrefixes: ["sk_test_", "rk_test_"],
    countVar: "NUM_CUSTOMERS",
    countCapVar: "EXPECTED_CUSTOMER_COUNT_NON_CACHE",
    countDefault: 500,
    countCapDefault: 100,
  },
  hubspot: {
    tokenVar: "HUBSPOT_ACCESS_TOKEN",
    catalogIdVar: "PEAKA_HUBSPOT_CATALOG_ID",
    schemaNameVar: "PEAKA_HUBSPOT_SCHEMA_NAME",
    catalogNameVar: "PEAKA_HUBSPOT_CATALOG_NAME",
    tokenPrefixes: null,
    countVar: "NUM_CONTACTS",
    countCapVar: "EXPECTED_CONTACT_COUNT_NON_CACHE",
    countDefault: 500,
    // No confirmed live-query row cap for HubSpot yet (unlike Stripe's
    // measured 100-row List-API cap) - see tests/hubspot/c-data-and-cache.js.
    // Left at 100 as a placeholder default only; nothing asserts against it
    // until a real cap is measured.
    countCapDefault: 100,
  },
};

/**
 * Validates that all required credentials for one connector are set and
 * non-placeholder. Returns { ok: true, values: {...} } or
 * { ok: false, errors: string[] }. Never throws - callers (CLI or server)
 * decide how to surface errors; in Jest that means gating test registration
 * with test.skip rather than letting a throw fail the test (see
 * helpers/buildCtx.js and jest/**\/*.test.js).
 *
 * The connector's catalogNameVar is intentionally NOT required here - it's
 * an optional fallback only needed if the getCatalog API call can't
 * auto-discover the catalog's queryable name/slug. Read it directly from
 * process.env where ctx is built (see helpers/buildCtx.js).
 *
 * The connector's schemaNameVar IS required - unlike catalogName, it's used
 * directly by nearly every scenario as a config value rather than something
 * discovered at runtime, so there's no live-lookup fallback for it.
 *
 * requireToken defaults to true (matches Stripe's original all-or-nothing
 * behavior). Pass { requireToken: false } for scenarios that only ever read
 * a PRE-EXISTING catalog and never call createConnection - e.g. HubSpot's
 * B/C/F/I/J/K, which don't need HUBSPOT_ACCESS_TOKEN at all, unlike G/H/L/M/N
 * and the races (which provision their own connection and DO need it). This
 * matters in practice: obtaining a HubSpot credential requires a HubSpot
 * account, which not everyone running this suite has - the token-optional
 * scenarios stay usable without one.
 */
function checkCredentials(connectorId = "stripe", { requireToken = true } = {}) {
  const spec = CONNECTOR_SPECS[connectorId];
  if (!spec) {
    throw new Error(`Unknown connector "${connectorId}". Known connectors: ${Object.keys(CONNECTOR_SPECS).join(", ")}`);
  }

  const errors = [];
  const values = {};

  const requiredVars = ["PEAKA_API_KEY", "PEAKA_PROJECT_ID", spec.catalogIdVar, spec.schemaNameVar];
  if (requireToken) requiredVars.push(spec.tokenVar);

  for (const name of requiredVars) {
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

  if (
    requireToken &&
    spec.tokenPrefixes &&
    values[spec.tokenVar] &&
    !spec.tokenPrefixes.some((p) => values[spec.tokenVar].startsWith(p))
  ) {
    errors.push(
      `${spec.tokenVar} must be a TEST key (one of: ${spec.tokenPrefixes.join(", ")}...). Refusing to run against a live key.`
    );
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

module.exports = { loadDotEnv, checkCredentials, PLACEHOLDER_VALUES, CONNECTOR_SPECS };
