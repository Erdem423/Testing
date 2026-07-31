/**
 * Metadata for the concurrency-races folder, read dynamically by server.js.
 *
 * This folder is the first real proof that the dynamic connector discovery in
 * server.js works as designed: adding this file is the ONLY change needed for
 * these scenarios to appear as their own card in the dashboard. No server.js
 * edits, no frontend edits. `discoverConnectors()` scans tests/ for subfolders
 * containing a meta.js, and runCLI is pointed at jest/<folder-id>/, which
 * already exists as jest/races/.
 *
 * ⚠️ These tests DELIBERATELY manufacture concurrency conflicts, and several
 * of them cache `customers` - the same table the Stripe folder's `C` caches.
 * Never run this folder at the same time as the Stripe folder. server.js's
 * runInProgress guard already prevents two dashboard runs overlapping, and
 * jest.config.js excludes jest/races/ so `npm test` can't pick them up, but
 * running `npm test` in a terminal while this folder runs in the browser would
 * still collide.
 *
 * On the CLI these run via `npm run test:races` (jest.races.config.js).
 *
 * As with tests/stripe/meta.js, `steps` is display metadata and must stay in
 * sync with the actual step("...") calls in tests/races/*.js.
 */
module.exports = {
  displayName: "Concurrency Races",
  icon: "⚡",
  scenarios: [
    {
      // Long - every step provisions a fresh cache on a ~37s-syncing table and
      // waits for it to settle again afterwards. The three cancel steps add a
      // trigger-and-settle cycle each on top of that, so budget ~7 minutes.
      name: "RACE-T1: Cache operation conflicts",
      category: "Cache races",
      steps: [
        "provision an isolated catalog for the races",
        "CANARY: querying rows mid-sync returns 0 (validates the harness)",
        "duplicate createCache mid-sync (known 500) is non-destructive",
        "deleteCache mid-sync does not orphan the cache",
        "simultaneous incremental + full refresh do not corrupt the cache",
        "cancelling a running incremental update settles cleanly",
        "cancelling a running full refresh settles cleanly",
        "cancelling a running materialized refresh never wedges the query",
        "the slow table is left uncached",
      ],
    },
    {
      // The last step is gated behind RUN_RISKY_RACES=true and will report as
      // skipped from the dashboard, which cannot set environment variables.
      name: "RACE-T2: Cross-resource conflicts",
      category: "Cross-resource races",
      steps: [
        "deleteConnection racing an in-flight query",
        "deleteQuery racing its own running export",
        "updateConnection to a bad token racing a query",
        "deleteCatalog racing a syncing cache (gated: RUN_RISKY_RACES)",
      ],
    },
    {
      name: "RACE-T3: Metadata races and parallel load",
      category: "Metadata & load races",
      steps: [
        "resolve catalog name",
        "listTables/listColumns while metadata is being refreshed",
        "listTables while a table is being cached (predicted safe)",
        "two metadata refreshes fired simultaneously",
        // This step's name is built from PARALLEL_QUERY_COUNT in
        // tests/races/tier3.js, so the resolved literal appears here. If that
        // constant changes, this string must change with it or the dashboard
        // will show the step as permanently "pending".
        "20 parallel queries degrade gracefully",
      ],
    },
  ],
};
