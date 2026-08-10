/**
 * Metadata for the Postgres connector folder, read dynamically by server.js.
 *
 * This folder is the first real test of the repo's long-standing claim that a
 * new connector needs "zero core changes". The claim turned out to be half
 * true: the framework is connector-agnostic, but the config layer was not -
 * helpers/env.js required STRIPE_TEST_TOKEN of every run. That is now split
 * into core credentials plus a per-connector tests/<id>/config.js, which is
 * the only core change this folder needed.
 *
 * WHY THERE ARE ONLY TWO SCENARIOS, and no cache or race equivalents:
 * Postgres tables are not cacheable at all - 0 of 40 across 10 schemas, with
 * createCache enforced against it. Peaka's cache exists to escape slow,
 * paginated remote APIs, and Trino queries a database directly. So C, M, O and
 * all four race tiers are structurally inapplicable here rather than missing.
 *
 * Runs with the ordinary `npm test` - unlike the races, there is nothing
 * dangerous about these and no reason to isolate them.
 *
 * As with tests/stripe/meta.js, `steps` is display metadata and must stay in
 * sync with the actual step("...") calls in the files below.
 */
module.exports = {
  displayName: "Postgres",
  icon: "🐘",
  scenarios: [
    {
      // The architecture proof: exercises config -> ctx -> client -> catalog
      // against a non-Stripe connector, and pins the non-cacheability finding.
      name: "PG-A: Catalog & Schema Discovery",
      category: "Discovery",
      steps: [
        "read the configured Postgres catalog",
        "list schemas and find the configured one",
        "list tables in the configured schema",
        "columns on the large table carry real declared types",
        "no Postgres table is cacheable, in any schema",
        "creating a cache on a Postgres table is refused",
      ],
    },
    {
      // The mirror image of Stripe's C: asserts the 100-row cap does NOT
      // apply here, which is what makes the cap connector-specific rather
      // than a Peaka-wide bug.
      name: "PG-B: Data Correctness",
      category: "Data",
      steps: [
        "resolve the catalog and discover a table to test",
        "COUNT(*) returns the real row count, not a cap",
        "a SELECT returns as many rows as it asks for",
        "a WHERE filter spans the whole table",
        "the aggregate matches a total computed from the fetched rows",
        "values arrive as strings regardless of declared type",
        "a double aggregate is returned in scientific notation",
      ],
    },
    {
      // The other half of Stripe K's export-cap finding. K asserts the export
      // IS capped; this asserts it is NOT - together they prove the cap is
      // connector-specific rather than a property of Peaka's export pipeline.
      name: "PG-C: Export Endpoints",
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
      // The third independent route to the cap finding, after queries (PG-B)
      // and exports (PG-C). Stripe's materialized query freezes 100 of 505
      // rows permanently; this asserts Postgres captures the whole table.
      name: "PG-D: Materialized Query Endpoints",
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
      // The ONLY scenario here needing real database credentials - everything
      // else reuses the existing connection. Skips when they are absent.
      name: "PG-E: Connection Endpoints",
      category: "Connections",
      steps: [
        "sweep leftover connections from crashed runs",
        "create a connection",
        "the connection actually reaches the database",
        "invalid credentials are rejected, never silently accepted",
        "error messages never echo the password",
        "list connections includes the new one",
        "get connection returns its metadata",
        "connection responses never leak the database password",
        "update the connection's name",
        "the POSTGRES connector configuration is published",
        "delete the connection and confirm it is gone",
      ],
    },
    {
      // Identifier resolution should be connector-agnostic; pagination is not.
      // The last step pages BEYOND where Stripe's cap would stop, which its
      // counterpart structurally cannot do.
      name: "PG-F: Error Handling & Pagination",
      category: "Data",
      steps: [
        "resolve the catalog and discover a table",
        "querying a non-existent table returns a clean error",
        "a non-existent schema is rejected by name",
        "a non-existent column is rejected by name",
        "pagination works past the point Stripe's cap would stop at",
      ],
    },
    {
      // Carries a finding of its own: table statistics are unimplemented for
      // Stripe catalogs but work for Postgres, so that gap is connector-
      // specific rather than an unbuilt Peaka feature.
      name: "PG-G: Catalog Endpoints",
      category: "Discovery",
      steps: [
        "discover a table on the shared catalog",
        "create a catalog on the existing connection",
        "list catalogs includes the new one and the configured one",
        "search finds a table in the Postgres catalog",
        "table statistics ARE supported for Postgres, unlike Stripe",
        "delete the catalog and confirm it is gone",
      ],
    },
    {
      // Saved-query CRUD, plus a fourth route to the cap finding: running the
      // saved query returns the whole table rather than the live cap.
      name: "PG-H: Saved Query Endpoints",
      category: "Queries",
      steps: [
        "resolve the catalog and discover a table",
        "create a saved query",
        "list queries includes the new one",
        "read the query back",
        "update the query to read a real Postgres table",
        "running the saved query returns the whole table, not the live cap",
        "transpile SQL to another dialect",
        "delete the query and confirm it is gone",
      ],
    },
    {
      name: "PG-I: Metadata Refresh Endpoints",
      category: "Discovery",
      steps: [
        "create a catalog to refresh",
        "read the refresh status before triggering anything",
        "trigger a metadata refresh",
        "refresh status reaches a terminal state",
        "the catalog is still discoverable after refreshing",
        "delete the throwaway catalog",
      ],
    },
  ],
};
