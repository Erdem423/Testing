/**
 * Metadata for the HubSpot concurrency-races folder, read dynamically by
 * server.js. Mirrors tests/races/meta.js - see that file's header comment
 * for the full "how dynamic connector discovery works" writeup.
 *
 * ⚠️ These tests DELIBERATELY manufacture concurrency conflicts and cache
 * `contacts` in throwaway catalogs. Never run this folder at the same time
 * as the HubSpot folder's `C` (Data Correctness & Cache Behavior) - same
 * reasoning as the Stripe races vs. Stripe `C`.
 *
 * On the CLI these run via `npm run test:races` (jest.races.config.js, which
 * covers both jest/races/ and jest/hubspot-races/).
 *
 * `steps` is display metadata and must stay in sync with the actual
 * step("...") calls in tests/hubspot-races/*.js.
 */
module.exports = {
  displayName: "HubSpot Races",
  icon: "⚡",
  scenarios: [
    {
      name: "RACE-T1: Cache operation conflicts",
      category: "Cache races",
      steps: [
        "provision an isolated catalog for the races",
        "CANARY: querying rows mid-sync (validates the harness enters the window)",
        "duplicate createCache mid-sync is non-destructive",
        "deleteCache mid-sync does not orphan the cache",
        "simultaneous incremental + full refresh do not corrupt the cache",
        "cancelling a running incremental update settles cleanly",
        "cancelling a running full refresh settles cleanly",
        "the slow table is left uncached",
      ],
    },
    {
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
        "20 parallel queries degrade gracefully",
      ],
    },
  ],
};
