/**
 * Runtime configuration for the MongoDB connector folder.
 *
 * A THIRD DATA POINT, not just a second one. Stripe and Postgres already
 * settled two attribution questions - the 100-row cap is connector-specific
 * (Postgres bypasses it), and string serialization is platform-wide (both
 * arrive as JS strings). MongoDB confirms both hold for a document store too,
 * not just for a second relational database:
 *
 *   the 100-row cap      -> still CONNECTOR-SPECIFIC. A LIMIT 150 against the
 *                           `commerce` collection (25000 rows) returns all 150.
 *   string serialization -> still PLATFORM-WIDE. bigint and double arrive as
 *                           JS strings here exactly as they do for Stripe and
 *                           Postgres.
 *   cacheability          -> still a property of the connector CLASS. 0 of 2
 *                           collections report isCacheable, and createCache
 *                           is enforced with the same clean 400
 *                           TABLE_NOT_CACHEABLE Postgres gets.
 *
 * WHAT'S ACTUALLY NEW HERE is `_id`. Every MongoDB document has one, but it is
 * absent from listColumns and from `SELECT *` entirely - the schema mapper
 * drops it. It is still selectable BY NAME, but the value that comes back
 * under the SIMPLE query format is Trino's raw VARBINARY rendering (hex byte
 * pairs joined by spaces, e.g. "6a 4c 8d 06 ..."), not a usable ObjectId
 * string - and the obvious `WHERE _id = '<hex>'` fails outright, because the
 * declared type is a distinct ObjectId type that does not compare against a
 * varchar or varbinary literal. `CAST(_id AS VARCHAR)` and Trino's
 * Mongo-connector `objectid('<hex>')` function both work. See FINDINGS.md.
 *
 * REUSES AN EXISTING CONNECTION, same reasoning as tests/postgres/config.js:
 * creating a MongoDB connection needs a connection string/password in .env,
 * and this database is real rather than disposable. The connection id is not
 * a secret; the password would be.
 */
module.exports = {
  // Measured live: "peaka_mongodb", not "mongodb". See tests/postgres/
  // config.js for why this has to be declared rather than inferred.
  catalogTypes: ["peaka_mongodb"],
  requiredEnv: ["PEAKA_MONGO_CATALOG_ID", "PEAKA_MONGO_SCHEMA_NAME"],

  catalogIdEnv: "PEAKA_MONGO_CATALOG_ID",
  schemaEnv: "PEAKA_MONGO_SCHEMA_NAME",
  connectionIdEnv: "PEAKA_MONGO_CONNECTION_ID",

  // Measured live 2026-08-13: 0 of 2 collections report isCacheable, and
  // createCache refuses both with a clean 400 TABLE_NOT_CACHEABLE - same
  // enforcement Postgres gets, same underlying reason (Trino queries Mongo
  // directly; there is nothing for a cache to escape).
  supportsCaching: false,

  usesStripeClient: false,

  // Optional escape hatch: set PEAKA_MONGO_TABLE to pin a specific collection
  // instead of letting the preflight pick the largest one it finds.
  tableEnv: "PEAKA_MONGO_TABLE",
};
