/**
 * Runtime configuration for the HubSpot connector folder - see
 * tests/stripe/config.js and tests/postgres/config.js for the pattern this
 * follows.
 *
 * requiredEnv deliberately does NOT include HUBSPOT_ACCESS_TOKEN. Unlike
 * Stripe (every scenario needs the key), most HubSpot scenarios
 * (B/C/F/I/J/K) only ever read the pre-existing catalog behind
 * PEAKA_HUBSPOT_CATALOG_ID and never call createConnection - obtaining a
 * HubSpot credential requires a HubSpot account, which not everyone running
 * this suite has, so those scenarios stay usable without one. Only
 * G/H/L/M/N (which provision their own throwaway connection) need the
 * token - each of those files checks HUBSPOT_ACCESS_TOKEN itself on top of
 * requireCredentials("hubspot"), rather than that being expressed here.
 */
module.exports = {
  // "hubspot" matches this folder's name, so the picker already found it -
  // declared explicitly for the same reason as the others (see
  // tests/postgres/config.js). Not measured live here: no HubSpot catalog
  // was available in the project this was checked against, so this preserves
  // exactly the behaviour that was already working rather than guessing at a
  // different value.
  catalogTypes: ["hubspot"],
  requiredEnv: ["PEAKA_HUBSPOT_CATALOG_ID", "PEAKA_HUBSPOT_SCHEMA_NAME"],

  catalogIdEnv: "PEAKA_HUBSPOT_CATALOG_ID",
  schemaEnv: "PEAKA_HUBSPOT_SCHEMA_NAME",
  catalogNameEnv: "PEAKA_HUBSPOT_CATALOG_NAME",

  // Read by helpers/buildCtx.js into ctx.token for connectors that declare
  // it - HubSpot connections in Peaka are OAuth2 (accessToken/refreshToken/
  // clientId/clientSecret/redirectUrl per getConnectionConfig("hubspot")),
  // and HUBSPOT_ACCESS_TOKEN is whatever single token value works as
  // accessToken (see tests/hubspot/g-connections.js's
  // credential: { accessToken: ctx.token }).
  tokenEnv: "HUBSPOT_ACCESS_TOKEN",

  // HubSpot is an API connector (like Stripe), so Peaka caches it to escape
  // upstream pagination - tests/hubspot/c-data-and-cache.js and
  // m-cache-management.js exercise this.
  supportsCaching: true,

  usesStripeClient: false,
};
