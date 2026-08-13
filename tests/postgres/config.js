/**
 * Runtime configuration for the Postgres connector folder.
 *
 * THIS FOLDER EXISTS TO ANSWER AN ATTRIBUTION QUESTION. Every finding in
 * FINDINGS.md was measured against Stripe, so none of them could say whether
 * the behaviour belonged to Peaka or to Peaka's Stripe connector. A second
 * connector settles it, and the first two answers are already in:
 *
 *   the 100-row cap      -> CONNECTOR-SPECIFIC. Postgres returns whole tables,
 *                           uncapped at any LIMIT.
 *   string serialization -> PLATFORM-WIDE. bigint and double both arrive as
 *                           JS strings here exactly as they do for Stripe.
 *
 * REUSES AN EXISTING CONNECTION rather than creating its own. Creating a
 * Postgres connection needs url/port/user/password in .env, and this database
 * is real rather than a disposable sandbox. The connection id is not a secret;
 * the password would be. That is the only reason scenario G has no Postgres
 * equivalent - everything else needs a catalog, not a connection.
 *
 * NOTHING ABOUT THE DATA IS DECLARED HERE ANY MORE. This file used to hardcode
 * `e_commerce`/`users`, a row count of 25000 and a filtered count of 2528, all
 * asserted exactly - which meant the folder only ran against ONE person's
 * database and had no env override. The scenarios now DISCOVER their fixture at
 * runtime (largest table in the schema, a real value sampled from it, a numeric
 * column read from the column list), so any Postgres catalog works.
 *
 * The claim being tested only needs "a table with well over 100 rows", never
 * "exactly 25000" - so nothing was lost by removing the numbers.
 */
module.exports = {
  // Only ids, no secrets. See the note above about why no credentials here.
  requiredEnv: ["PEAKA_PG_CATALOG_ID", "PEAKA_PG_SCHEMA_NAME"],

  catalogIdEnv: "PEAKA_PG_CATALOG_ID",
  schemaEnv: "PEAKA_PG_SCHEMA_NAME",
  connectionIdEnv: "PEAKA_PG_CONNECTION_ID",

  // NOT CACHEABLE, and this is a property of the connector class rather than
  // of this database. Measured 2026-08-04: 0 of 40 tables across 10 schemas
  // report isCacheable, MongoDB is 0 of 2, and createCache is enforced against
  // it with 400 TABLE_NOT_CACHEABLE.
  //
  // Peaka's cache exists to escape slow, paginated remote APIs. Trino queries
  // Postgres directly over JDBC, so there is nothing to escape. That single
  // fact is why C, M, O and all four race tiers have no Postgres counterpart -
  // they are not missing work, they are structurally inapplicable.
  supportsCaching: false,

  usesStripeClient: false,

  // Optional escape hatch: set PEAKA_PG_TABLE to pin a specific table instead
  // of letting the preflight pick the largest one it finds. Useful for a schema
  // where the biggest table is not the most representative.
  tableEnv: "PEAKA_PG_TABLE",
};
