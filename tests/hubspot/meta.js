/**
 * Metadata for the hubspot connector folder, read dynamically by server.js
 * when it scans tests/ for subfolders (see server.js's discoverConnectors()).
 * Mirrors tests/stripe/meta.js - see that file's header comment for the full
 * "how to add a connector" writeup, which applies here verbatim.
 *
 * `scenarios[].steps` here is DISPLAY metadata only (not run individually,
 * not tracked per-step) and must stay in sync with the actual step("...", ...)
 * calls in this connector's tests/hubspot/*.js files. Covers B/C/F/G/H/I/J/K/L/M/N -
 * the full endpoint surface Stripe's suite covers.
 *
 * HUBSPOT_ACCESS_TOKEN is required by G, H, L, M, N - all five call
 * createConnection to provision their own isolated connection+catalog.
 * (Reusing the existing connection behind PEAKA_HUBSPOT_CATALOG_ID instead -
 * to avoid needing a token for H/L/M/N - was tried and rejected by Peaka
 * with a 500 Internal Server Error when a second catalog is attached to an
 * already-catalogued connection; see tests/hubspot/h-catalogs.js's header
 * comment.) These five report as skipped in the dashboard until a token is
 * configured. B, C, F, I, J, K only read the pre-existing catalog and run
 * fine WITHOUT it - their jest/hubspot/ wrapper files call
 * buildCtx("hubspot", { requireToken: false }).
 */
module.exports = {
  displayName: "HubSpot",
  icon: "🧡",
  scenarios: [
    {
      name: "B: Catalog & Schema Discovery",
      category: "Discovery",
      steps: [
        "read pre-existing catalog",
        "list schemas",
        "list tables and check core tables present",
        "verify cache capability flags",
        "list columns for 'contacts'",
        "list columns for 'companies'",
        "list columns for 'deals'",
      ],
    },
    {
      name: "C: Data Correctness & Cache Behavior",
      category: "Data & Cache",
      steps: [
        "resolve catalog name",
        "data-correctness tables all start uncached",
        "live counts are measured (no cap assumed for HubSpot)",
        "a live SELECT with a large LIMIT is logged for cap detection",
        "live field-level spot check",
        "create caches on all data-correctness tables",
        "all caches reach a completed sync",
        "data-correctness tables now report isCached",
        "cached counts are measured and compared against live",
        "a cached SELECT with a large LIMIT is logged for cap comparison",
        "live vs cached comparison summary",
        "cache creation on a non-cacheable table fails cleanly",
        "duplicate cache creation is handled cleanly",
      ],
    },
    {
      name: "F: Error Handling & Edge Cases",
      category: "Errors",
      steps: [
        "resolve catalog name",
        "querying a non-existent table returns a clean error",
        "pagination via limit/offset returns non-overlapping pages",
      ],
    },
    {
      name: "G: Connection Endpoints",
      category: "Connections",
      steps: [
        "create a connection",
        "an invalid token is not silently accepted",
        "list connections includes the new one",
        "get connection returns its metadata",
        "connection response never leaks the HubSpot token",
        "update the connection's name",
        "list supported connector configurations",
        "get the hubspot connector configuration",
        "delete the connection and confirm it is gone",
      ],
    },
    {
      name: "H: Catalog Endpoints",
      category: "Catalogs",
      steps: [
        "create a connection to hang the catalog off",
        "create a catalog",
        "list catalogs includes the new one and the configured one",
        "search finds a known HubSpot table",
        "table statistics: log whether hubspot catalogs are supported",
        "delete the catalog and confirm it is gone",
      ],
    },
    {
      name: "I: Saved Query Endpoints",
      category: "Queries",
      steps: [
        "create a saved query",
        "list queries includes the new one",
        "read the query back",
        "update the query's SQL",
        "execute the saved query by id",
        "execute the saved query by its qualified name",
        "transpile SQL to another dialect",
        "delete the query and confirm it is gone",
      ],
    },
    {
      name: "J: Internal Table Endpoints",
      category: "Tables",
      steps: [
        "create an internal table",
        "list internal tables includes the new one",
        "add columns to the table",
        "list columns reflects what was added",
        "delete a column",
        "delete the table and confirm it is gone",
      ],
    },
    {
      name: "K: Export Endpoints",
      category: "Exports",
      steps: [
        "create a query to export from",
        "start a CSV export",
        "poll the export until it reaches a terminal state",
        "a succeeded export exposes downloadable files",
        "list exports includes this job",
        "cancel is accepted and idempotent",
      ],
    },
    {
      name: "L: Metadata Refresh Endpoints",
      category: "Metadata",
      steps: [
        "create a connection and catalog to refresh",
        "read the refresh status before triggering anything",
        "trigger a metadata refresh",
        "refresh status reaches a terminal state",
        "the catalog is still discoverable after refreshing",
      ],
    },
    {
      name: "M: Cache Management Endpoints",
      category: "Cache",
      steps: [
        "provision an isolated catalog",
        "create a cache on a fast-syncing table",
        "cache reaches a completed sync",
        "read cache settings",
        "update cache schedules and read them back",
        "a malformed schedule expression is never persisted",
        "disable the schedule again",
        "execution history lists the completed sync",
        "project-wide cache statuses include this cache",
        "catalog-wide cache statuses include this cache",
        "schema-wide cache statuses (status not yet confirmed for hubspot)",
        "trigger an incremental update",
        "cancel with nothing running reports not-found",
        "trigger a full refresh",
        "cancel a full refresh with nothing running reports not-found",
        "batch cache creation reports per-item results",
        "delete the cache and confirm it is gone",
      ],
    },
    {
      name: "N: Materialized Query Endpoints",
      category: "Queries",
      steps: [
        "provision an isolated catalog",
        "create a materialized query",
        "its status reaches a terminal state",
        "the project-wide status list includes it",
        "trigger a refresh and wait for it to settle",
        "cancel with nothing running is handled cleanly",
        "a refresh always brings the query back to COMPLETED",
        "a materialized query can reference an existing query",
        "delete the materialized query",
      ],
    },
  ],
};
