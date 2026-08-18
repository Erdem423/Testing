const { checkFor } = require("../../helpers/buildCtx");
const { PLACEHOLDER_VALUES } = require("../../helpers/env");

/**
 * Credential check for the Stripe scenarios that CREATE A STRIPE CONNECTION
 * in Peaka (G/H/L/M/N/O) - the only ones that genuinely cannot run without
 * STRIPE_TEST_TOKEN.
 *
 * WHY THIS EXISTS. The token used to sit in tests/stripe/config.js's
 * requiredEnv, which made it a precondition for the WHOLE folder: with no
 * .env, all twelve scenarios were unreachable and the dashboard's Run button
 * was dead, even though six of them never touch Stripe's own API. Six now
 * run - B, C, F, I, J and K read the existing catalog through Peaka like any
 * other connector.
 *
 * Same mechanism and same reasoning as tests/hubspot/checkTokenCredentials.js,
 * which had already made this split for HubSpot.
 *
 * THE sk_test_ GUARD MOVES HERE WITH IT. helpers/env.js only validates
 * variables a connector declares as required, so taking the token out of
 * requiredEnv would have quietly retired the "refuse a live key" check. It is
 * repeated here, and helpers/stripeClient.js's constructor still refuses one
 * independently - this client CREATES AND DELETES customers, so neither guard
 * should rely on the other.
 */
function checkWithToken() {
  const base = checkFor("stripe");
  const token = process.env.STRIPE_TEST_TOKEN;
  const present = Boolean(token) && !PLACEHOLDER_VALUES.has(token);
  const errors = [
    // base.errors only exists when base.ok is false - a success return has no
    // errors field at all (see checkCredentials() in helpers/env.js).
    ...(base.errors || []),
  ];
  if (!present) {
    errors.push("Missing STRIPE_TEST_TOKEN (or still a placeholder) - required to create a Stripe connection.");
  } else if (!token.startsWith("sk_test_")) {
    errors.push("STRIPE_TEST_TOKEN must be a Stripe TEST key (sk_test_...). Refusing to run against a live key.");
  }

  return { ok: base.ok && present && token.startsWith("sk_test_"), errors };
}

module.exports = { checkWithToken };
