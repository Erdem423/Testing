/**
 * Metadata for the Peaka Tables connector folder, read dynamically by
 * server.js. Scenario names carry the source doc's own IDs (PT-xx/BT-xx/
 * CMP-xx) so the dashboard and README's coverage table can reference the
 * doc directly.
 *
 * `steps` is display metadata and must stay in sync with the actual
 * step("...") calls in the files below - see tests/postgres/meta.js for
 * why this matters.
 */
module.exports = {
  displayName: "Peaka Tables",
  icon: "🗂️",
  scenarios: [
    {
      // The suite's first real write path: SqlExec is SELECT-only (see
      // peakaClient.js's executeQuery comment), so CSV import is the only
      // way to put data into a Peaka Table. Everything downstream that
      // needs seed data (PT-07/09/10, CMP-03) depends on this working.
      name: "PT-11: CSV import — happy path",
      category: "Peaka Table CRUD",
      steps: [
        "clean up any leftover table from a previous run",
        "create the table with name/age/score columns",
        "import a 10-row CSV",
        "row count matches the import job and a real COUNT(*)",
        "sampled rows match the imported values",
        "delete the table and confirm it is gone",
      ],
    },
    {
      // The doc expects all 4 mapping errors to be rejected and the table
      // to end up empty. Live behavior is different for one of them - see
      // the scenario file's header comment - so this scenario asserts what
      // is actually true rather than the doc's unverified assumption.
      name: "PT-12: CSV import — mapping errors",
      category: "Peaka Table CRUD",
      steps: [
        "clean up any leftover table from a previous run",
        "create the table with name/age/score columns",
        "reject a mapping to a nonexistent target column",
        "silently accept a mapping to a nonexistent CSV header, writing NULL",
        "reject csvColumnName when containsHeader is false",
        "reject malformed JSON in the request part",
        "delete the table and confirm it is gone",
      ],
    },
    {
      name: "PT-04: Column update and delete",
      category: "Peaka Table Management",
      steps: [
        "clean up any leftover table from a previous run",
        "create the table with col_a (VARCHAR) and col_b (BIGINT)",
        "update col_a's displayName",
        "delete col_b",
        "col_b is gone from the list and from SELECT",
        "delete the table and confirm it is gone",
      ],
    },
    {
      name: "BT-06: Column update and delete (BI Table)",
      category: "BI Table",
      steps: [
        "clean up any leftover table from a previous run",
        "create the BI Table with col_a (VARCHAR) and col_b (BIGINT)",
        "update col_a's displayName",
        "delete col_b",
        "col_b is gone from the list and from SELECT",
        "delete the BI Table and confirm it is gone",
      ],
    },
    {
      // Not a passing feature test - a pinned capability gap. The doc
      // expects real point-edit UPDATE/DELETE; the live API has no path
      // for either. See the scenario file's header comment.
      name: "PT-08: point-edit UPDATE/DELETE (capability gap)",
      category: "Peaka Table CRUD",
      steps: [
        "clean up any leftover table from a previous run",
        "create the table and import 2 known rows",
        "SqlExec UPDATE is rejected, and the row is genuinely untouched",
        "SqlExec DELETE is rejected, and the row count is genuinely unchanged",
        "no alternate row-level REST endpoint exists either",
        "delete the table and confirm it is gone",
      ],
    },
    {
      // Adapted from the doc's CMP-02 (Table x BI Table) - blocked since BI
      // Table has no write path. See the scenario file's header comment.
      name: "CMP: join across two Peaka Tables",
      category: "Integration",
      steps: [
        "clean up any leftover tables from a previous run",
        "create and seed the users table",
        "create and seed the events table with a known per-user distribution",
        "JOIN + GROUP BY across the two tables matches the known distribution",
        "delete both tables and confirm they are gone",
      ],
    },
  ],
};
