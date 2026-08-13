/**
 * Metadata for the Peaka Tables connector folder, read dynamically by
 * server.js.
 *
 * SCENARIO NAMES DESCRIBE WHAT EACH ONE ESTABLISHES rather than carrying the
 * source doc's IDs (PT-xx/BT-xx/CMP-xx), which is what they used to do. Two
 * reasons for the change: several scenarios here assert the OPPOSITE of what
 * the doc predicts, so leading with its ID overstated how closely they follow
 * it - and two have no doc counterpart at all. Where a finding genuinely does
 * trace back to the spec, the scenario file's own header comment cites it.
 *
 * NO COMMAS IN SCENARIO NAMES. server.js splits the dashboard's "Run Selected"
 * parameter on commas before matching each name exactly, so a name containing
 * one is split into fragments that match nothing and the button silently runs
 * ZERO tests for that scenario. A previous name here had this bug.
 *
 * `steps` is display metadata and must stay in sync with the actual
 * step("...") calls in the files below - see tests/postgres/meta.js for
 * why this matters.
 *
 * `refs` ANSWERS "WHICH WRITTEN RULE MADE THIS TEST NECESSARY?" - borrowed
 * from the Open Banking conformance suite, where every test case carries a
 * refURI pointing at the spec clause it enforces. The same facts were already
 * in each scenario file's header comment; putting them here makes them
 * computable. Three kinds, validated by scripts/check-refs.js:
 *
 *   { kind: "docs",    url: "https://docs.peaka.com/..." }  official docs
 *   { kind: "spec",    id: "PT-12" }                        the instructor's doc2 scenario
 *   { kind: "finding", id: 22 }                             a FINDINGS.md entry
 *
 * Run `npm run check:refs` after touching these: it fails on a finding id
 * with no matching FINDINGS.md heading, and reports which doc2 scenarios are
 * covered and which findings no scenario references.
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
      name: "CSV import writes every row exactly as given",
      category: "Peaka Table CRUD",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/api-reference/data--internal-tables/import-csv" },
        { kind: "spec", id: "PT-11" },
        { kind: "finding", id: 9 },
      ],
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
      name: "A bad mapping silently writes NULL instead of failing",
      category: "Peaka Table CRUD",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/api-reference/data--internal-tables/import-csv" },
        { kind: "spec", id: "PT-12" },
        { kind: "finding", id: 10 },
      ],
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
      // The unusual one: this pins GOOD behaviour. Value parsing on import is
      // strict and atomic, in direct contrast to the mapping handling the
      // bad-mapping scenario pins as broken - same endpoint, opposite rigor.
      // Asserted so a future relaxation toward the lax side is caught rather
      // than discovered by a user with corrupted data.
      name: "Invalid values are rejected strictly and atomically",
      category: "Peaka Table CRUD",
      refs: [
        { kind: "finding", id: 10 },
        { kind: "finding", id: 18 },
      ],
      steps: [
        "clean up any leftover table from a previous run",
        "create the table with six typed columns, including UUID",
        "an invalid value for a declared type is rejected, never silently stored",
        "a rejected import writes nothing, not even the valid rows before the bad one",
        "the same import shape succeeds when every value is valid",
        "delete the table and confirm it is gone",
      ],
    },
    {
      // Answers the question the no-row-edit scenario raises but cannot close:
      // if there is no UPDATE and no DELETE, what does re-importing do? It
      // APPENDS, with no dedup even for a byte-identical file - so a Peaka
      // Table can only ever grow, and a mistaken row can never be corrected.
      name: "Repeated import appends instead of replacing",
      category: "Peaka Table CRUD",
      refs: [
        { kind: "finding", id: 9 },
        { kind: "finding", id: 11 },
        { kind: "finding", id: 20 },
      ],
      steps: [
        "clean up any leftover table from a previous run",
        "create the table and import three rows",
        "importing the identical CSV again appends and does not deduplicate",
        "a second different CSV also appends rather than replacing",
        "delete the table and confirm it is gone",
      ],
    },
    {
      // Required fixing a client bug to even measure: getTableSample()
      // always returned body:null through this exact method, because
      // _request's res.json() throws on the endpoint's real text/csv
      // response. See helpers/peakaClient.js's _request `raw` option.
      name: "The sample endpoint returns a type-aware template with example rows",
      category: "Peaka Table CRUD",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/api-reference/data--internal-tables/get-sample-csv" },
        { kind: "spec", id: "PT-13" },
        { kind: "finding", id: 11 },
        { kind: "finding", id: 15 },
        { kind: "finding", id: 18 },
        { kind: "finding", id: 20 },
        { kind: "finding", id: 21 },
      ],
      steps: [
        "clean up any leftover table from a previous run",
        "the sample endpoint on a nonexistent table returns five blank lines, not an error",
        "create the table with a VARCHAR and a BIGINT column",
        "the header names the real columns behind one unexplained leading 'text' column",
        "values are type-aware but never real: VARCHAR gets 'sample text', BIGINT gets a random int",
        "the sample output is accepted when imported back as a template",
        "the round trip leaves placeholder rows that cannot be removed row by row",
        "delete the table and confirm it is gone",
      ],
    },
    {
      // The most customer-shaped scenario here: every other one declares its
      // columns up front and never touches them again, while real tables get
      // a new field two weeks after they are loaded. Dropping a column is
      // also the ONLY surgical way to remove data - there is no row DELETE.
      name: "Schema changes apply cleanly to a table that already holds data",
      category: "Peaka Table Management",
      refs: [
        { kind: "finding", id: 11 },
        { kind: "finding", id: 20 },
      ],
      steps: [
        "clean up any leftover table from a previous run",
        "create the table with col_a and col_b then seed two rows",
        "a column added to a populated table reads NULL for the existing rows",
        "an import carrying the new column populates only the new row",
        "deleting a column that holds data leaves every other column intact",
        "renaming a column's displayName does not break import mappings",
        "delete the table and confirm it is gone",
      ],
    },
    {
      // NOT an enforcement question - the two flags never round-trip at all.
      // Sent isUnique/isNotNull true, stored false, with a 200 in between.
      // Same shape as the BI Table displayName bug. defaultValue is the
      // control and it works end to end, which is what makes the other two a
      // targeted defect rather than the column body being ignored wholesale.
      name: "Unique and not-null flags are silently discarded at column creation",
      category: "Peaka Table Management",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/api-reference/data--internal-tables/add-column" },
        { kind: "spec", id: "PT-09" },
        { kind: "finding", id: 12 },
        { kind: "finding", id: 22 },
      ],
      steps: [
        "clean up any leftover table from a previous run",
        "create the table declaring a unique a not-null and a defaulted column",
        "the unique and not-null flags are silently discarded while defaultValue survives",
        "duplicate values import cleanly into the column declared unique",
        "an empty value imports cleanly into the column declared not-null",
        "a defaulted column is filled in when the import omits it entirely",
        "delete the table and confirm it is gone",
      ],
    },
    {
      // The deepest chain here: the last question is unreachable except after
      // five prior steps. Query OBJECT and query EXECUTION fail independently
      // - dropping a column or the whole table breaks running it with a clean
      // 400 while getQuery/listQueries keep working - and recreating the table
      // under the same name makes the orphaned query SILENTLY re-bind to the
      // new data.
      name: "A saved query tracks changes to the table beneath it",
      category: "Integration",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/api-reference/data--queries/execute-query" },
        { kind: "finding", id: 3 },
        { kind: "finding", id: 25 },
      ],
      steps: [
        "clean up any leftover table and query from a previous run",
        "create the table seed three rows and a saved query over it",
        "the saved query returns the same rows as the table underneath it",
        "dropping a column the query selects breaks execution but not the query",
        "deleting the table leaves the query stored but unrunnable",
        "recreating the table under the same name silently re-binds the query",
        "delete the query and the table and confirm both are gone",
      ],
    },
    {
      // The everyday Excel loop - export, edit, re-upload. It works, with one
      // catch: the exported header carries all eight system columns, so an
      // exported file is NOT directly re-importable and the mapping has to be
      // filtered. Note the asymmetry with the sample endpoint, which the spec
      // requires to be importable as-is. Also the 7th confirmation the
      // 100-row cap is Stripe-specific. ASYNC - the flakiest one here.
      name: "Data survives an export and re-import unchanged",
      category: "Integration",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/api-reference/data--exports/export-table-async" },
        { kind: "finding", id: 1 },
        { kind: "finding", id: 15 },
        { kind: "finding", id: 19 },
        { kind: "finding", id: 26 },
      ],
      steps: [
        "clean up any leftover tables from a previous run",
        "create the source table and import 150 rows",
        "export the table and poll until it succeeds",
        "the exported file holds every row so exports do not cap internal tables",
        "the exported header carries every system column ahead of the declared ones",
        "re-importing the exported file reproduces the values exactly",
        "delete both tables and confirm they are gone",
      ],
    },
    {
      // The docs promise a snapshot that "can be slightly stale between
      // refreshes". Over an internal table there is NO snapshot - appended
      // rows appear immediately, even after a confirmed materialization. The
      // exact inverse of FINDINGS 2, where a Stripe materialization freezes
      // at the capped 100 forever. The explicit-refresh step is load-bearing:
      // a fresh MATERIALIZED query reports COMPLETED with null timestamps,
      // which means "nothing in flight", not "materialized".
      name: "A materialized query over an internal table never goes stale",
      category: "Integration",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/connecting-your-data/what-is-materialized-query" },
        { kind: "finding", id: 2 },
        { kind: "finding", id: 27 },
      ],
      steps: [
        "clean up any leftover table and query from a previous run",
        "create the table seed three rows and a materialized query over it",
        "an explicit refresh performs a real materialization",
        "rows appended after materialization are visible without any refresh",
        "a further refresh changes nothing because there was no snapshot to update",
        "delete the query and the table and confirm both are gone",
      ],
    },
    {
      // The most serious scenario in the folder. Peaka advertises cross-source
      // querying; the Stripe connector's UNDOCUMENTED 100-row cap propagates
      // straight through a federated join, so an aggregate over the join is
      // silently computed on 100 of 505 rows and looks like a valid answer.
      // The Postgres leg is the control proving the join is not the limiter,
      // which is why this is gated on a COMPOSITE key requiring both
      // connectors rather than on Stripe alone.
      name: "A federated join inherits the Stripe row cap",
      category: "Integration",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/connecting-your-data/peaka-query" },
        { kind: "docs", url: "https://docs.peaka.com/api-reference/data--queries/execute-query" },
        { kind: "finding", id: 1 },
        { kind: "finding", id: 24 },
      ],
      steps: [
        "clean up any leftover table from a previous run",
        "create and seed a small internal table",
        "joining to Postgres returns every row so the join itself is not the limiter",
        "joining to Stripe silently truncates the result at the connector cap",
        "delete the table and confirm it is gone",
      ],
    },
    {
      // The Postgres equivalent (PG-A) gets a clean 400 TABLE_NOT_CACHEABLE.
      // Internal tables never reach that check at all - createCache dies
      // looking up a mangled internal identifier and returns errorCode null,
      // identically for both table kinds. Second place today an unrelated
      // internal failure ate this endpoint's errorCode (FINDINGS 28 is the
      // first), which makes it a pattern. Needs no rows, so no gate.
      name: "Cache creation on a BI Table fails before it can be refused",
      category: "BI Table",
      refs: [
        { kind: "finding", id: 28 },
        { kind: "finding", id: 30 },
      ],
      steps: [
        "clean up any leftover BI Table from a previous run",
        "create a throwaway BI Table",
        "the BI Table reports itself as not cacheable",
        "creating a cache on it fails before it can be refused",
        "delete the BI Table and confirm it is gone",
      ],
    },
    {
      // The only route by which BI Table data reaches a table the API can
      // write to: no import route exists for the bitable path (FINDINGS 29),
      // so the round trip has to land in a Peaka Table. The export carries
      // _operation, the ninth system column a Peaka Table lacks, so it is even
      // less directly re-importable than a Peaka Table export (FINDINGS 26).
      // ASYNC - shares the export flakiness FINDINGS records.
      name: "A BI Table exports into a Peaka Table which is the only way out",
      category: "BI Table",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/api-reference/data--exports/export-table-async" },
        { kind: "finding", id: 26 },
        { kind: "finding", id: 29 },
        { kind: "finding", id: 31 },
      ],
      steps: [
        "the preflight found a BI Table holding rows",
        "export the BI Table and poll until it succeeds",
        "the exported file holds every row the BI Table reported",
        "the export carries _operation which a Peaka Table export does not",
        "the exported rows import into a Peaka Table",
        "delete the destination table and confirm it is gone",
      ],
    },
    {
      // DELIBERATELY DOES NOT answer the four-way materialization question
      // (Stripe freezes at the cap, Postgres snapshots, Peaka Table does not).
      // Settling it needs the base table to drift, and a BI Table has no write
      // path - so a real snapshot and a live pass-through are indistinguishable
      // here. What it does pin: a filter through the materialized query agrees
      // with the same filter on the table, which is what a dashboard depends on.
      name: "A materialized query over a BI Table agrees with the table underneath",
      category: "BI Table",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/connecting-your-data/what-is-materialized-query" },
        { kind: "finding", id: 27 },
        { kind: "finding", id: 29 },
      ],
      steps: [
        "the preflight found a BI Table holding rows",
        "create a materialized query over the BI Table",
        "an explicit refresh produces a new execution",
        "the materialized query returns the same rows as the BI Table",
        "a filter through the materialized query agrees with the same filter on the table",
        "delete the materialized query and confirm it is gone",
      ],
    },
    {
      // The docs promise row-by-row updates, deletions, insertions AND bulk
      // insertion for a BI Table. The Partner API delivers none of them. This
      // is distinct from the Peaka Table row-edit pin: with real Studio-entered
      // rows present, every refusal is followed by re-reading the whole table
      // and proving the contents are byte-identical - which an empty BI Table
      // could never demonstrate, since "nothing changed" is trivially true
      // with no rows. Gated on there being rows to protect.
      name: "A populated BI Table refuses every documented write",
      category: "BI Table",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/connecting-your-data/peaka-bi-table" },
        { kind: "spec", id: "BT-05" },
        { kind: "finding", id: 9 },
        { kind: "finding", id: 11 },
      ],
      steps: [
        "read the BI Table's current contents as a baseline",
        "SqlExec refuses INSERT UPDATE and DELETE on a BI Table",
        "no import route exists for the bitable path",
        "no row-level REST endpoint exists under any plausible name",
        "the data is byte for byte what it was before every attempt",
      ],
    },
    {
      // CLOSES THE SPEC'S CMP-02, which the join scenario above had to
      // substitute away because nothing in the Partner API can seed a BI
      // Table. Rows entered through Studio ARE visible to the API, so every
      // READ path is testable - and the join seeds the Peaka Table side from
      // values discovered in the BI Table at runtime.
      //
      // Asserts invariants rather than values (COUNT vs full scan, filter
      // subsets, GROUP BY subtotals summing back), so editing the data in
      // Studio cannot break it. Gated: a project with no BI Table rows skips.
      name: "BI Table rows are queryable and join to a Peaka Table",
      category: "BI Table",
      refs: [
        { kind: "docs", url: "https://docs.peaka.com/connecting-your-data/differences-of-peaka-table-and-peaka-bi-table" },
        { kind: "spec", id: "CMP-02" },
        { kind: "finding", id: 11 },
      ],
      steps: [
        "the preflight found a BI Table holding rows",
        "a full scan and COUNT star agree on how many rows exist",
        "every row carries the system columns a BI Table is documented to add",
        "a projection returns the same rows as a full scan",
        "a filter returns a subset consistent with the full scan",
        "GROUP BY subtotals sum back to the total row count",
        "a Peaka Table joins to the BI Table on values discovered at runtime",
        "delete the join table and confirm it is gone",
      ],
    },
    {
      // The spec's CMP-01, plus the collision its own version never creates:
      // underscore stripping means the same requested name produces two
      // different stored names. Isolation holds on every axis - which also
      // proves helpers/cleanup.js cannot delete across namespaces.
      name: "A Peaka Table and BI Table sharing a name stay isolated",
      category: "Integration",
      refs: [
        { kind: "spec", id: "CMP-01" },
        { kind: "finding", id: 9 },
        { kind: "finding", id: 13 },
        { kind: "finding", id: 20 },
        { kind: "finding", id: 21 },
        { kind: "finding", id: 23 },
      ],
      steps: [
        "clean up any leftover tables from a previous run",
        "the same requested name yields two different stored names",
        "neither listing leaks into the other namespace",
        "a Peaka Table created under the BI Table's stored name coexists with it",
        "each table keeps its own columns and rows under the shared name",
        "deleting the Peaka Table leaves the BI Table listed and queryable",
        "delete both remaining tables and confirm they are gone",
      ],
    },
    {
      name: "Peaka Table columns rename and delete cleanly",
      category: "Peaka Table Management",
      refs: [
        { kind: "spec", id: "PT-04" },
      ],
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
      // Pins the assumption every OTHER scenario here silently depends on:
      // each one opens with a "clean up any leftover table" step and then
      // assumes a blank slate. Delete turns out to be a genuine hard drop of
      // both data AND declared schema - so recreating a name gives a table
      // carrying only Peaka's system columns.
      name: "Deleting a table purges its data and its schema",
      category: "Peaka Table Management",
      refs: [
        { kind: "spec", id: "PT-06" },
        { kind: "finding", id: 21 },
      ],
      steps: [
        "clean up any leftover table from a previous run",
        "create the table and seed three rows",
        "the listing and SQL agree the deleted table is gone",
        "recreating the same name gives a blank table with no declared columns",
        "a re-seeded row never reuses a deleted row's id",
        "delete the table and confirm it is gone",
      ],
    },
    {
      name: "BI Table silently ignores displayName on every column change",
      category: "BI Table",
      refs: [
        { kind: "spec", id: "BT-06" },
        { kind: "finding", id: 12 },
      ],
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
      name: "No row-level UPDATE or DELETE exists anywhere",
      category: "Peaka Table CRUD",
      refs: [
        { kind: "spec", id: "PT-08" },
        { kind: "finding", id: 9 },
        { kind: "finding", id: 11 },
      ],
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
      // Table cannot be seeded through the API. See the scenario header.
      name: "Joins across two Peaka Tables return correct groupings",
      category: "Integration",
      refs: [
        { kind: "spec", id: "CMP-02" },
      ],
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
