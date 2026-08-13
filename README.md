# Peaka × Stripe Connector Test Suite

An end-to-end Jest suite that validates [Peaka](https://peaka.com)'s Stripe connector against the real
[Peaka Partner API](https://docs.peaka.com/api-reference/introduction) and a seeded Stripe sandbox.

Peaka is a data-integration platform: you connect a source (here, Stripe), it exposes the source's
tables through a SQL interface, and it can *cache* those tables locally for faster reads. This suite
checks that the whole chain works — connection → catalog → schema → tables → queries → caches — and that
the data coming out is actually correct.

**There are no mocks.** Every test talks to a live Peaka project and a live Stripe test account. That is
the point: the failures worth finding are in the real API's behaviour, not in a stub of it. It also
means runs take about 85 seconds, need credentials, and create and delete real resources.

## What it found

Testing against the real API surfaced several genuine product bugs. Full write-ups, with evidence and
reproduction steps, are in **[FINDINGS.md](FINDINGS.md)**.

| Finding | Severity |
|---|---|
| Live (uncached) queries silently return at most **100 rows** — any query, not just `COUNT(*)` | **High** |
| Deleting a cache can leave a table **permanently unreachable** through Peaka | **High** |
| Duplicate `createCache` during an in-progress sync returns `500`, not the documented `409` | Medium |
| `cancelFullRefresh` throws a `NullPointerException` on a null execution record | Medium |
| Some cacheable tables produce cache jobs that hang forever, **indistinguishably from healthy** | Medium |

FINDINGS.md also documents two bugs found in *this suite* that produced green tests proving nothing —
worth reading before adding assertions of your own.

## Prerequisites

- **Node.js ≥ 18** (uses the built-in `fetch`)
- A **Peaka** project with a Stripe connection and catalog already set up in Peaka Studio
- A **Stripe test account** with seeded data — customers, charges, subscriptions and invoices. Several
  tests assert on real counts and distributions, so an empty sandbox will not do.

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
PEAKA_API_KEY=your_peaka_partner_api_key
PEAKA_PROJECT_ID=your_peaka_project_id
STRIPE_TEST_TOKEN=sk_test_your_stripe_test_key
PEAKA_CATALOG_ID=your_existing_peaka_catalog_id
PEAKA_CATALOG_NAME=stripe
PEAKA_SCHEMA_NAME=payment
NUM_CUSTOMERS=505
EXPECTED_CUSTOMER_COUNT_NON_CACHE=100
```

| Variable | Where it comes from |
|---|---|
| `PEAKA_API_KEY` | Peaka Studio → Developer ([guide](https://docs.peaka.com/how-to-guides/how-to-manage-partner-api-key)) |
| `PEAKA_PROJECT_ID` | Your project's URL or settings in Peaka Studio |
| `STRIPE_TEST_TOKEN` | A Stripe **test** secret key (`sk_test_…`). The suite refuses to run against a live key |
| `PEAKA_CATALOG_ID` | An existing catalog, created alongside its connection in Studio. `B` reads this catalog rather than creating one |
| `PEAKA_CATALOG_NAME` | The catalog's SQL-queryable name. Used as a fallback if the live lookup fails |
| `PEAKA_SCHEMA_NAME` | The Stripe connector's schema, e.g. `payment`. `B` cross-checks it against a live `listSchemas` |
| `NUM_CUSTOMERS` | Your **real** customer count — `C` compares cached reads against it |
| `EXPECTED_CUSTOMER_COUNT_NON_CACHE` | The known live-query cap (`100`). A deliberate regression test — see [FINDINGS.md](FINDINGS.md#1-live-queries-cannot-return-more-than-100-rows) before changing it |

> ⚠️ `.env` holds real credentials and is git-ignored. Do not commit it.

## Running

```bash
npm test                 # the main suite, ~85s
npm run test:races       # the concurrency suite, ~10 min (see below)
npm run web              # browser dashboard at http://localhost:3000
```

Sample output:

```
PASS jest/stripe/j-internal-tables.test.js    ✓ J: Internal Table Endpoints (3651 ms)
PASS jest/stripe/h-catalogs.test.js           ✓ H: Catalog Endpoints (4409 ms)
PASS jest/stripe/g-connections.test.js        ✓ G: Connection Endpoints (5882 ms)
PASS jest/stripe/k-exports.test.js            ✓ K: Export Endpoints (7307 ms)
PASS jest/stripe/i-queries.test.js            ✓ I: Saved Query Endpoints (7734 ms)
PASS jest/stripe/n-materialized-queries.test.js ✓ N: Materialized Query Endpoints (13653 ms)
PASS jest/stripe/l-metadata.test.js           ✓ L: Metadata Refresh Endpoints (17677 ms)
PASS jest/stripe/m-cache-management.test.js   ✓ M: Cache Management Endpoints (34459 ms)
PASS jest/stripe/connector.test.js
  ✓ B: Catalog & Schema Discovery (5077 ms)
  ✓ C: Data Correctness & Cache Behavior (62927 ms)
  ✓ F: Error Handling & Edge Cases (4189 ms)

Test Suites: 9 passed, 9 total
Tests:       11 passed, 11 total
```

Run one scenario on its own with `npx jest -t "M: Cache Management Endpoints"`.

Resources created during a run are deleted automatically in `afterAll`. To leave them for inspection:

```bash
SKIP_CLEANUP=true npm test
```

### The concurrency suite

`npm run test:races` is a **separate** suite that deliberately manufactures conflicts — cancelling a
sync mid-flight, creating a duplicate cache while the first is still running, querying a table as it is
being cached. It has its own config (`jest.races.config.js`), runs single-threaded, and is excluded from
`npm test`. See [CONCURRENCY-SPEC.md](CONCURRENCY-SPEC.md) for the design and results.

> ⚠️ **Never run the two suites at the same time.** Both drive real Jest runs against the same Peaka
> project and the same tables. Overlapping them creates *unintended* races on top of the intended ones,
> and the result looks exactly like a code regression. A preflight check refuses to start the races if
> it detects another run.

### The web dashboard

`npm run web` serves a browser UI at **http://localhost:3000** that runs the same Jest suites and streams
results live. It is not an alternative implementation — `server.js` calls Jest's own programmatic API
(`runCLI`), so what you see is a real Jest run.

The sidebar lists one card per test folder, discovered by scanning `tests/` for subfolders containing a
`meta.js`. Select scenarios, click **Run Selected**, and watch each step report itself as it executes.
Credentials never reach the browser — `server.js` reads `.env` itself and sends only results.

## What each scenario covers

| Scenario | Covers |
|---|---|
| **B: Catalog & Schema Discovery** | Reading the configured catalog, discovering its schema and core tables, verifying cache-capability flags and expected columns |
| **C: Data Correctness & Cache Behavior** | Every count and distribution assertion run **twice** — once uncached, once served from cache — with the full cache lifecycle in between, plus non-cacheable rejection and duplicate-creation handling |
| **F: Error Handling & Edge Cases** | Querying a non-existent table; pagination correctness across pages |
| **G: Connection Endpoints** | Connection CRUD, invalid-token handling, the connector-config catalogue, and a **credential-masking check** asserting the Stripe key is never echoed back |
| **H: Catalog Endpoints** | Catalog create/list/delete, project-wide search, table statistics |
| **I: Saved Query Endpoints** | Saved-query CRUD and SQL transpilation |
| **J: Internal Table Endpoints** | Peaka internal table and column CRUD |
| **K: Export Endpoints** | Async CSV export: start → poll to `SUCCEEDED` → read → list → cancel |
| **L: Metadata Refresh Endpoints** | Trigger a metadata refresh and poll it to a terminal state |
| **M: Cache Management Endpoints** | Cache settings, batch creation, all three all-statuses variants, execution history, trigger/cancel for incremental and full refresh |
| **N: Materialized Query Endpoints** | Create, poll, list, refresh, cancel, recovery, and the `inputQueryRefId` variant |
| **O: Data Freshness** | Adds a customer **in Stripe**, proves it isn't visible in the cache, refreshes, and proves it is — then deletes it and checks the removal is reflected too |

> ⚠️ **`O` is the only scenario that writes to Stripe.** It creates one customer and deletes it again, so
> your sandbox's row counts are unchanged after a run. The id is tracked the instant it exists and
> [helpers/cleanup.js](helpers/cleanup.js) removes Stripe customers *before* any Peaka resource — a
> leftover customer would permanently shift the counts `C` asserts against. `helpers/stripeClient.js`
> refuses any key that isn't `sk_test_`.

A per-step breakdown is in [STRIPE_TEST_SCENARIOS.md](STRIPE_TEST_SCENARIOS.md).

## Project layout

```
helpers/
  peakaClient.js            - thin wrapper over the Peaka Partner API
  assert.js                 - assertion helpers
  step.js                   - runs a named sub-step, tagging errors with which step failed
  stepReporter.js           - emits live step events to the dashboard (no-op under npm test)
  buildCtx.js               - builds each scenario's isolated context
  env.js                    - .env loader + credential validation
  cleanup.js                - resource deletion (cache -> query -> table -> catalog -> connection)
  resolveCatalogName.js     - resolves the catalog's SQL name
  pollCacheUntilComplete.js - waits for a cache sync to finish
  cacheExecution.js         - reads a cache's true current status (see FINDINGS.md)
  raceWindow.js             - timing primitives for the concurrency suite
  racePreflight.js          - refuses to start the races if another run is active
tests/
  stripe/                   - one folder per connector, auto-discovered by server.js
    meta.js                 - scenario metadata for the dashboard
    b-catalog-schema.js … n-materialized-queries.js
  races/
    meta.js
    tier1.js, tier2.js, tier3.js
jest/
  stripe/
    connector.test.js       - B, C and F as test.concurrent() blocks
    g-connections.test.js … n-materialized-queries.test.js
  races/                    - tier1-3.test.js
  browserReporter.js        - custom reporter, streams results to the dashboard
  reporterBus.js
public/                     - dashboard frontend
server.js                   - dashboard backend (Express + Jest runCLI)
jest.config.js              - main suite config
jest.races.config.js        - concurrency suite config
```

## Design decisions worth knowing

**Steps, not sub-tests.** Each scenario is one Jest test that runs a sequence of named `step(...)` calls.
If a step fails, later steps in that scenario do not run, and the error is prefixed with the step name:

```
✕ B: Catalog & Schema Discovery
  [list tables and check core tables present] Expected core tables missing...
```

This keeps genuine dependencies (read catalog → discover schema → discover tables) as plain sequential
`await`s instead of hidden ordering requirements between separate `test()` declarations.

**Two parallelism models.** `B`, `C` and `F` share one file as `test.concurrent()` blocks — concurrent
promises in a single worker. `G` through `N` each have their own file, so Jest schedules them across
separate worker processes. Both are safe because every scenario builds its own isolated context with its
own client and its own resource-tracking arrays; nothing is shared.

**Scenarios that create caches provision their own catalog.** `L`, `M`, `N` and the races each create a
throwaway connection and catalog rather than using the shared one. Caches attach to a catalog, and
querying a table whose cache is mid-sync returns zero rows — so a scenario caching a table another
scenario reads live is one scheduling accident away from a confusing failure. This is not hypothetical:
`N` hit it for real before being isolated.

**`C` and `D` were merged for the same reason.** Keeping cache behaviour separate from data correctness
required each to avoid the other's tables. Merged, the race is impossible and the live-versus-cached
difference becomes the *subject* of the test rather than a hazard to route around.

## Troubleshooting

**`Refusing to start the concurrency races — another test run appears to be active`**
Stop the dashboard, or whatever else is running, first. On Windows, Git Bash's `pkill` only sees its own
process tree and will silently kill nothing — use PowerShell:

```bash
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Running the races *from* the dashboard is supported and will not trip this check.

**`There is no catalog with this application and catalog id`**
`PEAKA_CATALOG_ID` points at a catalog that no longer exists — usually because it was deleted and
re-created in Studio. Update `.env` with the new id.

**`CORRUPTED CACHE STATE: [table] report isCached:true but no cache is listed`**
A real Peaka bug, not a test failure. See
[FINDINGS.md](FINDINGS.md#2-deleting-a-cache-can-permanently-break-a-table) — the repair is to rebuild
the catalog in Studio, keeping the same name.

**`connect EACCES <ip>:443`**
The process cannot open outbound connections. Most often the dev server was started in a restricted or
sandboxed shell; start it from a normal terminal.

**Tests failing in files you did not touch, with times roughly doubled**
That pattern is contention, not a regression. Something else is running against the same Peaka project —
check for a stray `node server.js` and confirm port 3000 is actually free.

Note that `npm run test:races | grep … && npm test` is a trap: `&&` sees *grep's* exit code, not Jest's,
so the second suite runs even when the first failed and then overlaps with it.

## Continuous integration

`.github/workflows/nightly-test.yml` runs `npm test` on a schedule rather than per-push — this suite
mostly catches Peaka- and Stripe-side drift, so a time-based cadence matters more than commit triggers.
It also exposes a manual **Run workflow** button.

Required repository secrets (**Settings → Secrets and variables → Actions**): `PEAKA_API_KEY`,
`PEAKA_PROJECT_ID`, `STRIPE_TEST_TOKEN`, `PEAKA_CATALOG_ID`, `PEAKA_SCHEMA_NAME`, `NUM_CUSTOMERS`,
`EXPECTED_CUSTOMER_COUNT_NON_CACHE`, and optionally `SLACK_WEBHOOK_URL`. No `.env` is needed —
`helpers/env.js` prefers real environment variables.

**Use a dedicated Peaka project for automated runs**, separate from the one you test against manually.
Scheduled automation sharing a project with a human reintroduces exactly the resource-collision class
this suite already had to design around.

**The workflow deliberately does not use `jest.retryTimes()`.** Jest's built-in retry reports only the
last attempt, discarding the first failure's data. Several findings in FINDINGS.md were caught precisely
*because* nothing silently retried. Instead the suite runs once and, only on failure, runs again as a
separate visible step — so "failed once, passed on retry" is reported as flaky rather than hidden.

## Adding another connector

Create `tests/<connector>/` with your scenario files and a `meta.js` (copy `tests/stripe/meta.js`), and
`jest/<connector>/` with the matching test files. `server.js` discovers folders under `tests/` at request
time by looking for a `meta.js`, so the new folder appears in the dashboard with no changes to the server
or frontend.

## Related documents

| Document | Contents |
|---|---|
| [FINDINGS.md](FINDINGS.md) | Peaka API bugs found, with evidence and reproduction steps |
| [STRIPE_TEST_SCENARIOS.md](STRIPE_TEST_SCENARIOS.md) | Step-by-step breakdown of every scenario |
| [CONCURRENCY-SPEC.md](CONCURRENCY-SPEC.md) | Design and results of the concurrency suite |
| [COVERAGE.md](COVERAGE.md) | Coverage against the original requirements |
