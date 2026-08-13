# Peaka Partner API Test Suite

An end-to-end Jest suite that validates the [Peaka Partner API](https://docs.peaka.com/api-reference/introduction)
against three things: a live Stripe connector, a live Postgres (Supabase) connector, and Peaka's own
built-in Peaka Table / BI Table feature.

Peaka is a data-integration platform: you connect a source, it exposes the source's tables through a SQL
interface, and — for API connectors — it can *cache* those tables locally for faster reads. This suite
checks that the whole chain works, and running the same questions against more than one connector is what
turns an observation ("Peaka does X") into an attribution ("Peaka's *Stripe connector* does X, but not its
Postgres connector") — see [What it found](#what-it-found) below.

**There are no mocks.** Every test talks to a live Peaka project. That is the point: the failures worth
finding are in the real API's behaviour, not in a stub of it. It also means runs take real time, need
credentials, and create and delete real resources.

## What it found

Testing against the real API surfaced several genuine product bugs, and — via a second and third
connector — settled which platform claims were connector-specific rather than Peaka-wide. Full write-ups,
with evidence and reproduction steps, are in **[FINDINGS.md](FINDINGS.md)**.

| Finding | Severity |
|---|---|
| Live (uncached) Stripe queries silently return at most **100 rows** — any query, not just `COUNT(*)` | **High** |
| That cap is **connector-specific**, proven four independent ways against Postgres (queries, exports, materialization, saved queries) | **High** |
| `SqlExec` cannot write at all — the instructor's Peaka Table spec assumes DML through it, and it does not exist | **High** |
| CSV import silently accepts a mapping to a nonexistent column and writes `NULL` instead of rejecting it | **High** |
| No row-level UPDATE/DELETE endpoint exists anywhere for internal tables — SQL or REST | **High** |
| Deleting a cache can leave a table **permanently unreachable** through Peaka | **High** |
| BI Table's `displayName` is never respected, and the update endpoint's response actively lies about it | Medium |
| Duplicate `createCache` during an in-progress sync returns `500`, not the documented `409` | Medium |

FINDINGS.md also documents bugs found in *this suite itself* — including two tests that were passing
green while receiving a `500`, and two that produced green results proving nothing — worth reading before
adding assertions of your own.

## Prerequisites

**Required for any run:**

- **Node.js ≥ 18** (uses the built-in `fetch`)
- A **Peaka** project and a Partner API key

That alone runs the `peaka-tables` folder, which creates and seeds everything it asserts against.

**Optional — each unlocks more scenarios:**

| To run | You need |
|---|---|
| The Stripe folder | A Peaka Stripe connection + catalog, and a Stripe **test** account with data |
| The Postgres folder | A Peaka Postgres connection + catalog with at least one table of >100 rows |

**No numbers to configure.** Expected values are measured at runtime — the customer count comes
from Stripe's own API, and the Postgres fixture (which table, how many rows, which column to
filter on) is discovered from the catalog. Nothing needs tuning to match your data.

**Missing data skips rather than fails.** A run measures the environment first, skips the
scenarios whose data is absent, and exits **non-zero** with a list of what did not execute — so a
partial run can never be mistaken for a full pass. See [Incomplete runs](#incomplete-runs).

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
PEAKA_API_KEY=your_peaka_partner_api_key
PEAKA_PROJECT_ID=your_peaka_project_id

# Stripe folder (omit to skip those scenarios)
STRIPE_TEST_TOKEN=sk_test_your_stripe_test_key
PEAKA_CATALOG_ID=your_existing_peaka_catalog_id
PEAKA_CATALOG_NAME=stripe
PEAKA_SCHEMA_NAME=payment

# Postgres folder (omit to skip those scenarios)
PEAKA_PG_CATALOG_ID=your_postgres_catalog_id
PEAKA_PG_SCHEMA_NAME=public
PEAKA_PG_CONNECTION_ID=your_postgres_connection_id

# MongoDB folder (omit to skip those scenarios)
PEAKA_MONGO_CATALOG_ID=your_mongo_catalog_id
PEAKA_MONGO_SCHEMA_NAME=your_mongo_database_name
PEAKA_MONGO_CONNECTION_ID=your_mongo_connection_id

EXPECTED_CUSTOMER_COUNT_NON_CACHE=100
```

| Variable | Where it comes from |
|---|---|
| `PEAKA_API_KEY` | Peaka Studio → Developer ([guide](https://docs.peaka.com/how-to-guides/how-to-manage-partner-api-key)) |
| `PEAKA_PROJECT_ID` | Your project's URL or settings in Peaka Studio |
| `STRIPE_TEST_TOKEN` | A Stripe **test** secret key (`sk_test_…`). The suite refuses to run against a live key |
| `PEAKA_CATALOG_ID` | An existing Stripe catalog, created alongside its connection in Studio. `B` reads this catalog rather than creating one |
| `PEAKA_CATALOG_NAME` | The catalog's SQL-queryable name. Used as a fallback if the live lookup fails |
| `PEAKA_SCHEMA_NAME` | The Stripe connector's schema, e.g. `payment`. `B` cross-checks it against a live `listSchemas` |
| `PEAKA_PG_CATALOG_ID` | An existing Postgres catalog. The folder reuses it rather than creating one — no database password is ever stored |
| `PEAKA_PG_SCHEMA_NAME` | The schema to test, e.g. `public` |
| `PEAKA_PG_CONNECTION_ID` | The connection behind that catalog. An id, not a secret |
| `PEAKA_PG_TABLE` | *Optional.* Pins a specific table instead of letting the preflight pick the largest one |
| `PEAKA_MONGO_CATALOG_ID` | An existing MongoDB catalog. The folder reuses it rather than creating one — no connection string is ever stored |
| `PEAKA_MONGO_SCHEMA_NAME` | The Mongo *database* to test — Peaka reports each Mongo database as one "schema", e.g. `e_commerce` |
| `PEAKA_MONGO_CONNECTION_ID` | The connection behind that catalog. An id, not a secret |
| `EXPECTED_CUSTOMER_COUNT_NON_CACHE` | The known live-query cap (`100`). A **product constant**, not your data — a deliberate regression test, see [FINDINGS.md](FINDINGS.md#1-live-queries-cannot-return-more-than-100-rows) before changing it |
| `ALLOW_INCOMPLETE` | Set to `true` to exit 0 despite skipped scenarios. See [Incomplete runs](#incomplete-runs) |
| `FAIL_ON_SERVER_ERROR` | Set to `true` to exit non-zero if any 5xx was observed, even a tolerated one. See [Server errors](#server-errors) |

> ⚠️ `.env` holds real credentials and is git-ignored. Do not commit it.

## Running

```bash
npm test                 # the main suite, ~85s
npm run test:races       # the concurrency suite, ~10 min (see below)
npm run web              # browser dashboard at http://localhost:3000
npm run check:refs       # traceability check, no API calls, instant
```

### Traceability — which rule made each test necessary

Every Peaka Tables scenario carries a `refs` array in its `meta.js` entry, linking it to the written
rule it exists to enforce: an official docs page, a scenario in the instructor's spec, or a
[FINDINGS.md](FINDINGS.md) entry. The idea is borrowed from the [Open Banking conformance
suite](https://github.com/OpenBankingUK/conformance-suite), where each test case carries a `refURI`
pointing at the spec clause it tests.

`npm run check:refs` validates those links and prints two tables worth having:

- **Spec coverage** — which of the spec's scenario ids are claimed by a test, so *"what do you actually
  cover?"* is answered by a script rather than by hand.
- **Findings cited by no scenario** — informational, since many findings are Stripe- or Postgres-only.

It **exits non-zero** when a scenario cites a finding number that has no matching `## <n>.` heading, which
is how a renumbered finding gets caught instead of silently dangling.

### Incomplete runs

Before any test loads, a **preflight** measures what data actually exists (`jest.globalSetup.js` →
`helpers/preflight.js`). Scenarios whose data is absent are skipped rather than run against an
empty catalog, because the alternative — failing deep inside a scenario after creating four
caches — reads like a product bug when it is really a setup gap.

Skipping is safe only if it can never be confused with passing, so a partial run:

- reports each skip as a real Jest `test.skip`, counted separately from passes
- prints a banner naming every scenario that did not execute, and why
- writes `test-results/coverage.json` — ran/skipped per scenario, machine-readable
- **exits non-zero**, so CI and `npm test && …` cannot treat it as a full pass

```
════════════════════════════════════════════════════════
  INCOMPLETE RUN — 3 of 20 scenarios did not execute
════════════════════════════════════════════════════════
  C: Data Correctness    Stripe catalog has 0 customers
  K: Export Endpoints    Stripe catalog has 0 charges
  PG-B: Data Correctness no table in 'public' exceeds 100 rows
  These scenarios verified NOTHING. Coverage was reduced.
════════════════════════════════════════════════════════
```

Set `ALLOW_INCOMPLETE=true` to accept the gap and exit 0 — deliberately a conscious choice rather
than the default.

**A broken API is never mistaken for missing data.** The preflight distinguishes a query that
*succeeds and returns zero rows* (→ skip) from one that *fails* (→ the run aborts). Without that
split, an outage would skip everything and look tidy — which is exactly the failure this design
exists to prevent, and which [FINDINGS.md](FINDINGS.md) records happening once already.

### Server errors

The instructor's spec is explicit: a `5xx` is always a bug, never an acceptable outcome, even in a
negative scenario. Two tests in this suite pass while tolerating a known, documented Peaka `500` — see
[FINDINGS.md](FINDINGS.md#server-errors-now-have-their-own-channel) — because the bugs are Peaka's and
outside this suite's control, and a permanently-red test for someone else's bug gets ignored, which is
how real regressions hide.

They still pass, but a `5xx` anywhere can no longer pass *silently*:

```
════════════════════════════════════════════════════════════════════════
  SERVER ERRORS — 1 5xx response across 27 scenarios
════════════════════════════════════════════════════════════════════════
  M: Cache Management Endpoints   [PASSED]
    schema-wide cache statuses (known 500)
      500  getAllCacheStatusesOfSchema
      KNOWN: the schema-level variant returns 500 while the project- and catalog-level ones work...
════════════════════════════════════════════════════════════════════════
```

Every `5xx` is recorded to `test-results/coverage.json` and shown in the dashboard as its own magenta
state — distinct from both a pass and a fail, since "passed but the server errored" is neither. The
default exit code is unaffected; set `FAIL_ON_SERVER_ERROR=true` to enforce the spec's rule literally.

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

### 🐘 Postgres — a second connector

`tests/postgres/` exists to answer a question the Stripe scenarios cannot: **which findings belong to
Peaka, and which belong to Peaka's Stripe connector?** It mirrors Stripe's B/C/F/G/H/I/K/L/N one-for-one —
everything except `M`, `O`, and the race tiers, which need caching and databases cannot be cached at all.

| Scenario | Covers |
|---|---|
| **PG-A: Catalog & Schema Discovery** | Catalog, schemas, tables and declared column types — and pins that **no database table is cacheable** (0 of 40, with `createCache` enforced) |
| **PG-B: Data Correctness** | The mirror of `C`: the 100-row cap does **not** apply to raw queries — 25,000 rows counted, `LIMIT 500` returning 500, filters spanning the whole table |
| **PG-C: Export Endpoints** | The mirror of `K`: a table export captures **all** requested rows (1,000 of 1,000), not the Stripe cap |
| **PG-D: Materialized Query Endpoints** | The mirror of `N`: the stored snapshot holds the **whole table** (25,000 rows), not frozen at 100 |
| **PG-E: Connection Endpoints** | The mirror of `G`, and the only Postgres scenario needing real database credentials — everything else reuses the existing connection |
| **PG-F: Error Handling & Pagination** | Identifier-resolution errors (mirrors `F`), plus pagination proven **past** where Stripe's cap would stop — something `F` cannot demonstrate |
| **PG-G: Catalog Endpoints** | The mirror of `H` — and finds that table statistics, unsupported for Stripe, work fully for Postgres |
| **PG-H: Saved Query Endpoints** | The mirror of `I`: executing a saved query by name returns the whole table, a fourth independent route to the cap finding |
| **PG-I: Metadata Refresh Endpoints** | The mirror of `L`, against a catalog with ~10 real schemas rather than Stripe's one |

**The row cap is connector-specific — proven four independent ways** (raw queries, exports,
materialization, saved queries), **the string serialization is platform-wide.** Table statistics are
connector-specific too. See [FINDINGS.md](FINDINGS.md) for the full comparison.

Adding this folder is also what finally tested the "a new connector needs zero core changes" claim below.
It was **half true**: the framework was connector-agnostic, but `helpers/env.js` demanded
`STRIPE_TEST_TOKEN` of every run. Connector settings now live in `tests/<connector>/config.js`, and
`buildFreshCtx("postgres")` is the only line that differs in a Postgres test file.

> ⚠️ **`O` is the only scenario that writes to Stripe.** It creates one customer and deletes it again, so
> your sandbox's row counts are unchanged after a run. The id is tracked the instant it exists and
> [helpers/cleanup.js](helpers/cleanup.js) removes Stripe customers *before* any Peaka resource — a
> leftover customer would permanently shift the counts `C` asserts against. `helpers/stripeClient.js`
> refuses any key that isn't `sk_test_`.

A per-step breakdown is in [STRIPE_TEST_SCENARIOS.md](STRIPE_TEST_SCENARIOS.md).

### 🗂️ Peaka Tables — the internal Peaka Table / BI Table spec

`tests/peaka-tables/` covers the instructor's separate spec for Peaka's two built-in table types. Unlike
Stripe and Postgres, neither needs a connection or catalog of its own — both live in the project's
always-present `peaka` catalog, so this folder runs on nothing but `PEAKA_API_KEY`/`PEAKA_PROJECT_ID`.

Scenario names describe what each one establishes rather than carrying the spec's IDs — several assert
the *opposite* of what the spec predicts, and two have no spec counterpart at all.

| Scenario | Covers |
|---|---|
| **CSV import writes every row exactly as given** | The only real write path into a Peaka Table (`SqlExec` is SELECT-only — see [FINDINGS.md](FINDINGS.md)) |
| **A bad mapping silently writes NULL instead of failing** | The spec expects all four bad-mapping cases to fail; one of them silently succeeds and writes `NULL` — asserted as the real, measured behaviour |
| **Invalid values are rejected strictly and atomically** | The mirror of the above, and the opposite result: bad *values* are rejected with excellent messages. Pins a guarantee, so a drift toward the lax mapping handling is caught |
| **Repeated import appends instead of replacing** | Re-importing never replaces and never deduplicates — combined with the absent row edits, a Peaka Table can only ever **grow** |
| **The sample endpoint returns a type-aware template with example rows** | A **template** generator, and it conforms to the spec — including the import round trip. Sole deviation: an undeclared `text` column in the header. Required fixing a client bug (silently returned `null`) to measure at all |
| **Peaka Table columns rename and delete cleanly** / **BI Table silently ignores displayName on every column change** | The same operation on each table kind — BI Table's `displayName` never actually persists, despite the API claiming it did |
| **Deleting a table purges its data and its schema** | A genuine hard drop: recreating the same name gives a blank table with no declared columns, and ids are never reused. Pins the blank-slate assumption every other scenario depends on |
| **Schema changes apply cleanly to a table that already holds data** | The most customer-shaped scenario here — add a column to a populated table, drop one that holds data, relabel one. All working, all pinned |
| **Unique and not-null flags are silently discarded at column creation** | Sent `true`, stored `false`, `200` in between — a settable field whose write never takes. `defaultValue` is the control and works end to end |
| **A Peaka Table and BI Table sharing a name stay isolated** | Covers the spec's `CMP-01` — plus the collision the spec's own version never creates, since underscore stripping means one requested name yields two different tables |
| **A saved query tracks changes to the table beneath it** | Drop a column or the whole table and execution breaks with a clean `4xx` while the stored query survives — then recreating the table under the same name makes the query **silently re-bind** to the new data |
| **A federated join inherits the Stripe row cap** | The folder's only gated scenario. Joining an internal table to Postgres returns all 50,000 rows; joining it to Stripe silently truncates at 100 — so an aggregate over the join looks like an answer and is wrong |
| **Data survives an export and re-import unchanged** | The Excel loop. Uncapped at 150 rows, values identical on the way back — but the export carries all 8 system columns, so the mapping has to be filtered first |
| **A materialized query over an internal table never goes stale** | Peaka's docs promise a snapshot that ages between refreshes; over an internal table there is none — appended rows appear immediately. The inverse of the Stripe materialization bug |
| **BI Table rows are queryable and join to a Peaka Table** | Closes the spec's `CMP-02`. Rows entered via Studio are fully readable, so the Peaka Table side is seeded from values *discovered* in the BI Table at runtime — asserting invariants, so editing the data can't break it |
| **A populated BI Table refuses every documented write** | The docs promise row-by-row inserts, updates, deletes and bulk insertion; the API delivers none. With real rows present it proves the data is byte-identical afterwards — impossible against an empty table |
| **A BI Table exports into a Peaka Table which is the only way out** | No import route exists for BI Tables, so the round trip lands in a Peaka Table — the only API-writable destination. The export carries `_operation`, the ninth system column |
| **A materialized query over a BI Table agrees with the table underneath** | Deliberately does *not* claim whether a snapshot is held — with no write path the base can't be made to drift. Pins the thing a dashboard depends on: filters agreeing through the materialized query |
| **Cache creation on a BI Table fails before it can be refused** | Postgres returns a clean `TABLE_NOT_CACHEABLE`; internal tables die looking up a mangled internal identifier with `errorCode: null` — for both table kinds |
| **No row-level UPDATE or DELETE exists anywhere** | Not a feature test — a pinned absence. No row-level edit path exists via SQL or REST |
| **Joins across two Peaka Tables return correct groupings** | Adapted from the spec's Table×BI-Table join, which the Partner API cannot seed. **Now also covered directly** by the BI Table read/join scenario, using rows entered through Studio |

Several of the spec's own assumptions about the platform turned out to be wrong — see findings 9–16 in
[FINDINGS.md](FINDINGS.md) for the full list, including why roughly half its 24 scenarios can't be built
as literally written.

## Project layout

```
helpers/
  peakaClient.js            - thin wrapper over the Peaka Partner API
  assert.js                 - assertion helpers, 5xx-aware (see serverError.js)
  serverError.js            - records 5xx responses so they can't pass silently
  step.js                   - runs a named sub-step, tagging errors with which step failed
  stepReporter.js           - emits live step events to the dashboard (no-op under npm test)
  buildCtx.js               - builds each scenario's isolated context
  env.js                    - .env loader + credential validation
  preflight.js              - measures the environment once; test.skip gating
  sweepConnections.js       - age-guarded cleanup of connections a killed run abandoned
  cleanup.js                - resource deletion (cache -> query -> table -> catalog -> connection)
  withTable.js              - create/run/delete lifecycle for Peaka Table / BI Table scenarios
  csvFixtures.js            - in-memory CSV generators, nothing written to disk
  resolveCatalogName.js     - resolves the catalog's SQL name
  pollCacheUntilComplete.js - waits for a cache sync to finish
  cacheExecution.js         - reads a cache's true current status (see FINDINGS.md)
  raceWindow.js             - timing primitives for the concurrency suite
  racePreflight.js          - refuses to start the races if another run is active
tests/
  stripe/                   - one folder per connector, auto-discovered by server.js
    meta.js                 - scenario metadata for the dashboard
    b-catalog-schema.js … n-materialized-queries.js
  postgres/                 - the second connector; fixture.js discovers its data at runtime
    meta.js
    pg-a-discovery.js … pg-i-metadata.js
  peaka-tables/              - no connection/catalog needed; lives in the built-in `peaka` catalog
    meta.js
    csv-import-*.js (happy-path, mapping-errors, type-coercion, repeats-append),
    table-column-update.js, bitable-column-update.js, table-delete-purge.js,
    sample-endpoint.js, no-row-level-edit.js, internal-table-join.js
  races/
    meta.js
    tier1.js … tier4.js
jest/
  stripe/
    connector.test.js       - B, C and F as test.concurrent() blocks
    g-connections.test.js … n-materialized-queries.test.js
  postgres/                 - pg-a-discovery.test.js … pg-i-metadata.test.js
  peaka-tables/             - one *.test.js per scenario
  races/                    - tier1-4.test.js
  reporters/
    incompleteRun.js        - skip banner + server-error banner, coverage.json, exit code
  browserReporter.js        - custom reporter, streams results to the dashboard
  reporterBus.js
public/                     - dashboard frontend
server.js                   - dashboard backend (Express + Jest runCLI)
jest.config.js              - main suite config
jest.races.config.js        - concurrency suite config
jest.globalSetup.js         - runs preflight once before any test file loads
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
`PEAKA_PROJECT_ID`, `STRIPE_TEST_TOKEN`, `PEAKA_CATALOG_ID`, `PEAKA_SCHEMA_NAME`,
`EXPECTED_CUSTOMER_COUNT_NON_CACHE`, optionally the `PEAKA_PG_*` trio for the Postgres folder, optionally
the `PEAKA_MONGO_*` trio for the MongoDB folder, and optionally `SLACK_WEBHOOK_URL`. No `.env` is needed —
`helpers/env.js` prefers real environment variables.

Note the CI job will **fail on an incomplete run**, which is the intended behaviour: a nightly that
silently stopped covering half the suite is worse than one that goes red. Set `ALLOW_INCOMPLETE=true`
only if you deliberately run CI against a partially-configured project.

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
