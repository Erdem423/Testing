const { checkFor } = require("../../helpers/buildCtx");
const { PLACEHOLDER_VALUES } = require("../../helpers/env");

/**
 * Credential check for the HubSpot scenarios that create a NEW connection
 * (G/H/L/M/N, the races) - unlike B/C/F/I/J/K, these genuinely need
 * HUBSPOT_ACCESS_TOKEN even though tests/hubspot/config.js doesn't require
 * it connector-wide (see that file's header comment for why: most HubSpot
 * scenarios only read the pre-existing catalog and never need a token, and
 * obtaining one requires a HubSpot account not everyone running this suite
 * has).
 *
 * Returns the same { ok, errors } shape as checkCredentials()/checkFor() so
 * callers can use it identically (maybeTest = check.ok ? test : test.skip).
 */
function checkWithToken() {
  const base = checkFor("hubspot");
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  const tokenOk = Boolean(token) && !PLACEHOLDER_VALUES.has(token);
  return {
    ok: base.ok && tokenOk,
    // base.errors only exists when base.ok is false (see checkCredentials()
    // in helpers/env.js - a success return has no errors field at all).
    errors: [
      ...(base.errors || []),
      ...(tokenOk ? [] : ["Missing HUBSPOT_ACCESS_TOKEN (or still a placeholder) - required to create a new HubSpot connection."]),
    ],
  };
}

module.exports = { checkWithToken };
