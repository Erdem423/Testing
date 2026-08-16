/**
 * Metadata for the Google Ads connector folder, read dynamically by server.js.
 *
 * The FOURTH connector, and the first outside the main Peaka project - see
 * tests/google-ads/config.js and helpers/env.js's checkCredentials() for the
 * apiKeyEnv/projectIdEnv mechanism that made a second project possible
 * without touching buildCtx.js or any scenario file.
 *
 * GA-C THROUGH GA-H PORT PG-C/D/F/G/H (themselves mirrors of the Stripe
 * suite) - same reasoning tests/postgres/meta.js and tests/mongodb/meta.js
 * give. A fifth connector confirming the cap and cacheability findings turns
 * "true so far" into "true in general" a bit further each time.
 *
 * NOT PORTED: GA-E (Connection Endpoints) and GA-I (Metadata Refresh). GA-E
 * needs real OAuth credentials to create a connection from scratch, same
 * reasoning tests/postgres/pg-e-connections.js gives for Postgres. GA-I needs
 * a THROWAWAY CATALOG to refresh (never the shared one, for the same
 * interference reasons PG-I/MO-I give) - and creating even that, on Google
 * Ads, turns out to ALSO need the OAuth client secret and refresh token
 * re-supplied, not just the existing connection's id (finding 36). Reusing
 * an existing connection was enough for Postgres and MongoDB; Google Ads
 * needs the credentials this suite was never given either way.
 *
 * GA-G IS SCOPED DOWN for the same reason: no catalog create/list/delete,
 * only the two assertions that don't need one - search, and the
 * table-statistics attribution (which agrees with MongoDB's: Postgres-only,
 * see finding 33).
 */
module.exports = {
  displayName: "Google Ads",
  icon: "📢",
  scenarios: [
    {
      name: "GA-A: Catalog & Schema Discovery",
      category: "Discovery",
      steps: [
        "read the configured Google Ads catalog",
        "list schemas and find the configured one",
        "list tables and discover one with real data to query",
        "columns on the table carry real declared types",
        "querying past 100 rows is not capped, unlike Stripe",
        "no Google Ads table is cacheable, in the schema this run touches",
        "creating a cache on a Google Ads table is refused",
        "this connector is measurably flaky, worth knowing before trusting a single red run",
      ],
    },
    {
      name: "GA-C: Export Endpoints",
      category: "Exports",
      steps: [
        "resolve the catalog and discover a table to export",
        "create a query to export from",
        "start a CSV export",
        "poll the export until it reaches a terminal state",
        "a succeeded export exposes downloadable files",
        "list exports includes this job",
        "exporting a table directly is NOT capped, unlike Stripe",
        "cancel is accepted and idempotent",
        "delete the export query",
      ],
    },
    {
      name: "GA-D: Materialized Query Endpoints",
      category: "Queries",
      steps: [
        "resolve the catalog and discover a table to materialize",
        "create a materialized query",
        "its status reaches a terminal state",
        "the project-wide status list includes it",
        "trigger a refresh and wait for it to settle",
        "the materialized result holds the WHOLE table, not the live cap",
        "cancel with nothing running is handled cleanly",
        "a refresh always brings the query back to COMPLETED",
        "delete the materialized query",
      ],
    },
    {
      name: "GA-F: Error Handling & Pagination",
      category: "Data",
      refs: [{ kind: "finding", id: 36 }],
      steps: [
        "resolve the catalog and discover a table",
        "querying a non-existent table returns a clean error",
        "a non-existent schema is rejected by name",
        "a non-existent column is rejected by name",
        "pagination works past the point Stripe's cap would stop at",
      ],
    },
    {
      name: "GA-G: Catalog Endpoints",
      category: "Discovery",
      refs: [{ kind: "finding", id: 33 }, { kind: "finding", id: 37 }],
      steps: [
        "discover a table on the shared catalog",
        "search finds a table in the Google Ads catalog",
        "table statistics are NOT supported for Google Ads, unlike Postgres",
      ],
    },
    {
      name: "GA-H: Saved Query Endpoints",
      category: "Queries",
      steps: [
        "resolve the catalog and discover a table",
        "create a saved query",
        "list queries includes the new one",
        "read the query back",
        "update the query to read a real Google Ads table",
        "running the saved query returns the whole table, not the live cap",
        "transpile SQL to another dialect",
        "delete the query and confirm it is gone",
      ],
    },
  ],
};
