/**
 * Runtime configuration for the Google Ads connector folder.
 *
 * A FOURTH connector, and the first that does NOT live in the main Peaka
 * project. Stripe, Postgres and MongoDB all share one project -
 * only the catalog differs between them, so the framework never needed to
 * know more than one PEAKA_API_KEY/PEAKA_PROJECT_ID. The instructor's Google
 * Ads connection lives in a SEPARATE project with its own key,
 * which is what apiKeyEnv/projectIdEnv exist for - see helpers/env.js's
 * checkCredentials(). Everything downstream (buildCtx.js, cleanup.js, every
 * scenario file) needs no changes: it still just reads ctx.client, built from
 * whichever key/project this config resolved to.
 *
 * THE CATALOG IS SPRAWLING - 150+ tables, the full Google Ads Query Language
 * resource schema, present regardless of whether the underlying account has
 * any real campaigns. Measured live 2026-08-14 against this specific
 * connection: it does - `ad_group_criterion` (2,860 rows) and
 * `keyword_stats_report` (2,668 rows) are both real, well past the Stripe
 * cap. Most of the 150+ tables are legitimately empty (e.g. `click_view`,
 * `keyword_plan`) for an account this size, not evidence of anything broken.
 *
 * REUSES THE EXISTING CONNECTION ("gads"), same reasoning as Postgres and
 * MongoDB: creating a Google Ads connection needs real OAuth credentials this
 * suite doesn't hold, so there is no connection-lifecycle scenario here.
 */
module.exports = {
  // Measured live: "google_ads", not this folder's name. See
  // tests/postgres/config.js for why the dashboard needs this declared.
  catalogTypes: ["google_ads"],
  // Fallback when PEAKA_*_SCHEMA_NAME is unset - the dashboard resolves a
  // picked connection to a schema, and "first one listed" is wrong for
  // several connectors. See helpers/peakaAccount.js's pickSchema().
  defaultSchema: "public",

  // Only the CLI path (`npm test`) needs these. The dashboard reaches this
  // project by connecting with its key and picking it in the project grid,
  // resolving catalog/schema from the connection you choose - no separate
  // env pair involved.
  apiKeyEnv: "PEAKA_API_KEY_ADS",
  projectIdEnv: "PEAKA_PROJECT_ID_ADS",

  requiredEnv: ["PEAKA_GOOGLE_ADS_CATALOG_ID", "PEAKA_GOOGLE_ADS_SCHEMA_NAME"],

  catalogIdEnv: "PEAKA_GOOGLE_ADS_CATALOG_ID",
  schemaEnv: "PEAKA_GOOGLE_ADS_SCHEMA_NAME",
  connectionIdEnv: "PEAKA_GOOGLE_ADS_CONNECTION_ID",

  // Measured live 2026-08-14: every table in this catalog reports
  // isCacheable: false - same as Postgres and MongoDB, and for the same
  // reason (Trino queries the connector directly; there is nothing a cache
  // would escape). Confirmed, not assumed - see the discovery scenario.
  supportsCaching: false,

  usesStripeClient: false,

  // Optional escape hatch, same as tests/postgres and tests/mongodb: set
  // PEAKA_GOOGLE_ADS_TABLE to pin a specific table instead of letting the
  // preflight scan for the largest one - useful here specifically, since a
  // scan across 150+ tables is expensive.
  tableEnv: "PEAKA_GOOGLE_ADS_TABLE",
};
