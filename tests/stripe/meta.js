/**
 * Metadata for this connector folder, read dynamically by server.js when it
 * scans tests/ for subfolders (see server.js's discoverConnectors()).
 *
 * To add a new connector later (Mongo, Supabase, etc.):
 *   1. Create tests/<name>/ with its own test files + a meta.js like this one
 *   2. Create jest/<name>/connector.test.js (see jest/stripe/connector.test.js
 *      as a reference for the pattern - build its own ctx, use
 *      test.concurrent(), afterAll cleanup)
 *   3. That's it - server.js discovers the new folder automatically and it
 *      shows up as a new folder card in the web app. No server.js or
 *      frontend changes needed.
 *
 * `scenarios[].steps` here is just DISPLAY metadata (the dashboard shows
 * these as a static list - it does NOT run them individually or track
 * per-step pass/fail) - it must stay in sync with the actual step("...", ...)
 * calls in this connector's tests/<name>/*.js files (kept as a separate,
 * hand-maintained list rather than derived automatically, since parsing
 * step() calls out of source or introspecting Jest's registered tests
 * without running them isn't straightforward). If you add/remove/rename a
 * step() call in a test file, update the matching entry here too - see the
 * README's "Known gaps" for a real example of this drifting out of sync
 * (`stepCount` used to be wrong for C and F after a step was added and this
 * file wasn't updated).
 */
module.exports = {
  displayName: "Stripe",
  icon: "💳",
  scenarios: [
    {
      // "A: Connection Setup" used to sit here. Merged into G on 2026-07-31 -
      // same subject, and A's create step asserted a subset of G's. See
      // tests/stripe/g-connections.js.
      name: "B: Catalog & Schema Discovery",
      category: "Discovery",
      steps: [
        "read pre-existing catalog",
        "list schemas",
        "list tables and check core tables present",
        "verify cache capability flags",
        "list columns for 'customers'",
        "list columns for 'charges'",
        "list columns for 'subscriptions'",
        "list columns for 'invoices'",
      ],
    },
    {
      // Merged from the former "C: Data Correctness" and "D: Cache Behavior".
      // Runs every correctness assertion twice - once uncached, once served
      // from cache - with the cache lifecycle in between. See
      // tests/stripe/c-data-and-cache.js for why they had to become one test.
      name: "C: Data Correctness & Cache Behavior",
      category: "Data & Cache",
      steps: [
        "resolve catalog name",
        "data-correctness tables all start uncached",
        "a SELECT returns the requested columns with correctly-shaped values",
        "live: the aggregate matches a total computed from the fetched rows",
        "live counts are capped at 100 on every table",
        "a live SELECT cannot return more than 100 rows",
        "live charge refund distribution is plausible",
        "live subscription status distribution is sane",
        "live field-level spot check on a specific seeded customer",
        "create caches on all data-correctness tables",
        "all caches reach a completed sync",
        "data-correctness tables now report isCached",
        "cached counts bypass the 100-row cap on every table",
        "a cached SELECT returns more than 100 rows",
        "cached customer count matches the real seeded count",
        "cached charge refund distribution is plausible",
        "cached subscription status distribution is sane",
        "cached invoice count is consistent with subscriptions",
        "cached: the aggregate matches a total computed from the fetched rows",
        "cached field-level spot check matches the live one",
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
        "a non-existent schema is rejected by name",
        "a non-existent column is rejected by name",
        "pagination via limit/offset returns non-overlapping pages",
      ],
    },
    // G-M cover the remaining base API endpoints, one simple test each.
    // Unlike A-F (four test.concurrent() blocks in one file), each of these
    // lives in its OWN jest/stripe/<name>.test.js so Jest runs them in
    // separate worker processes.
    {
      name: "G: Connection Endpoints",
      category: "Connections",
      steps: [
        "sweep abandoned connections from killed runs",
        "create a connection",
        "an invalid token is not silently accepted",
        "a connection with no usable credential is rejected",
        "list connections includes the new one",
        "get connection returns its metadata",
        "connection response never leaks the Stripe key",
        "connection detail returns no more than the plain read, and no credential",
        "update the connection's name",
        "list supported connector configurations",
        "get the stripe connector configuration",
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
        "search finds a known Stripe table",
        "table statistics are not supported for stripe catalogs",
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
        "move the query to a folder path and back",
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
        "exporting a table directly is capped at the live row limit",
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
        "schema-wide cache statuses (known 500)",
        "trigger an incremental update",
        "cancel with nothing running reports not-found",
        "trigger a full refresh",
        "cancel a full refresh with nothing running reports not-found",
        "batch cache creation reports per-item results",
        "delete the cache and confirm it is gone",
      ],
    },
    {
      // The only scenario that WRITES to Stripe. It creates a customer, proves
      // a refresh makes it visible, then deletes it again. Long by nature:
      // `customers` syncs in ~37s and this refreshes it up to three times.
      name: "O: Data Freshness",
      category: "Cache",
      steps: [
        "provision an isolated catalog",
        "cache the customers table and record a baseline count",
        "create a new customer directly in Stripe",
        "the new customer is not visible before a refresh",
        "an incremental update is tried first",
        "a full refresh is tried if incremental missed it",
        "a source row becomes visible after refreshing",
        "the incremental moved a delta, not the whole table",
        "an upstream update propagates to the cache",
        "deleting the customer upstream is reflected",
        "delete the cache",
      ],
    },
  ],
};

