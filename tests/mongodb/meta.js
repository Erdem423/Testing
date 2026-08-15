/**
 * Metadata for the MongoDB connector folder, read dynamically by server.js.
 *
 * The THIRD connector, after Stripe and Postgres, and the second real test of
 * "a new connector needs zero core changes" - see tests/postgres/meta.js for
 * the first. It held again: this folder plus measureMongoDB() in
 * helpers/preflight.js is the entire diff.
 *
 * MO-B THROUGH MO-I ARE A DIRECT PORT of PG-B through PG-I, which are
 * themselves mirrors of the Stripe suite - same reasoning tests/postgres/meta.js
 * gives for why it exists at all. Running the SAME question against a THIRD
 * connector is what turns "true for two connectors" into "true in general":
 *
 *   the 100-row cap        CONNECTOR-SPECIFIC, now confirmed a third way
 *                          across queries (MO-B), exports (MO-C), materialized
 *                          queries (MO-D), and saved queries (MO-H)
 *   string serialization   PLATFORM-WIDE, confirmed a third time (MO-B)
 *   pagination              works past where Stripe's cap would stop (MO-F)
 *   cacheability            still a property of the connector CLASS (MO-A)
 *
 * ONE PORT INVERTED RATHER THAN CONFIRMED: table statistics. PG-G shows
 * Postgres supports getTableStatistics while Stripe doesn't, which reads as
 * "database connectors get it" until MongoDB - also a database connector -
 * gets the exact same 400 Stripe does. MO-G asserts THAT, not what PG-G
 * asserts, because a third data point contradicted the two-connector pattern
 * rather than confirming it (see FINDINGS 33).
 *
 * NOT PORTED: PG-E (Connection Endpoints). It is the one Postgres scenario
 * needing real database credentials (url/port/user/password) rather than
 * reusing an existing connection, and this project has no MongoDB connection
 * string configured for it - same reasoning tests/postgres/pg-e-connections.js
 * gives for why creating a live connection needs its own credentials block.
 *
 * As with the other meta.js files, `steps` is display metadata and must stay
 * in sync with the actual step("...") calls in the files below.
 */
module.exports = {
  displayName: "MongoDB",
  icon: "🍃",
  scenarios: [
    {
      name: "MO-A: Catalog & Schema Discovery",
      category: "Discovery",
      refs: [{ kind: "docs", url: "https://docs.peaka.com/integrations/mongodb" }, { kind: "finding", id: 32 }],
      steps: [
        "read the configured MongoDB catalog",
        "list schemas and find the configured one",
        "list tables in the configured schema, and discover one to query",
        "columns on the collection carry real declared types",
        "querying past 100 rows is not capped, unlike Stripe",
        "no MongoDB collection is cacheable, in any schema",
        "creating a cache on a MongoDB collection is refused",
        "_id is completely absent from listColumns and from SELECT *",
        "_id is selectable by name, but the obvious ways to use it fail",
        "CAST(_id AS VARCHAR) and objectid(hex) are the working escape hatch",
      ],
    },
    {
      name: "MO-B: Data Correctness",
      category: "Data",
      steps: [
        "resolve the catalog and discover a collection to test",
        "COUNT(*) returns the real row count, not a cap",
        "a SELECT returns as many rows as it asks for",
        "a WHERE filter spans the whole collection",
        "the aggregate matches a total computed from the fetched rows",
        "values arrive as strings regardless of declared type",
        "a double aggregate is returned in scientific notation",
      ],
    },
    {
      name: "MO-C: Export Endpoints",
      category: "Exports",
      steps: [
        "resolve the catalog and discover a collection to export",
        "create a query to export from",
        "start a CSV export",
        "poll the export until it reaches a terminal state",
        "a succeeded export exposes downloadable files",
        "list exports includes this job",
        "exporting a collection directly is NOT capped, unlike Stripe",
        "cancel is accepted and idempotent",
        "delete the export query",
      ],
    },
    {
      name: "MO-D: Materialized Query Endpoints",
      category: "Queries",
      steps: [
        "resolve the catalog and discover a collection to materialize",
        "create a materialized query",
        "its status reaches a terminal state",
        "the project-wide status list includes it",
        "trigger a refresh and wait for it to settle",
        "the materialized result holds the WHOLE collection, not the live cap",
        "cancel with nothing running is handled cleanly",
        "a refresh always brings the query back to COMPLETED",
        "delete the materialized query",
      ],
    },
    {
      name: "MO-F: Error Handling & Pagination",
      category: "Data",
      steps: [
        "resolve the catalog and discover a collection",
        "querying a non-existent collection returns a clean error",
        "a non-existent schema is rejected by name",
        "a non-existent column is rejected by name",
        "pagination works past the point Stripe's cap would stop at",
      ],
    },
    {
      // The inverted attribution step - see the module comment above.
      name: "MO-G: Catalog Endpoints",
      category: "Discovery",
      refs: [{ kind: "finding", id: 33 }],
      steps: [
        "discover a collection on the shared catalog",
        "create a catalog on the existing connection",
        "list catalogs includes the new one and the configured one",
        "search finds a collection in the MongoDB catalog",
        "table statistics are NOT supported for MongoDB, unlike Postgres",
        "delete the catalog and confirm it is gone",
      ],
    },
    {
      name: "MO-H: Saved Query Endpoints",
      category: "Queries",
      steps: [
        "resolve the catalog and discover a collection",
        "create a saved query",
        "list queries includes the new one",
        "read the query back",
        "update the query to read a real MongoDB collection",
        "running the saved query returns the whole collection, not the live cap",
        "transpile SQL to another dialect",
        "delete the query and confirm it is gone",
      ],
    },
    {
      name: "MO-I: Metadata Refresh Endpoints",
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
