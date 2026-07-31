# Peaka × Stripe Connector Test Suite (Jest)

A Jest test suite validating Peaka's Stripe connector against the real [Peaka Partner API](https://docs.peaka.com/api-reference/introduction) and a seeded Stripe sandbox.

## Setup

```bash
npm install
```

Edit the `.env` file in this folder with your real values:

```
PEAKA_API_KEY=your_peaka_partner_api_key
PEAKA_PROJECT_ID=your_peaka_project_id
STRIPE_TEST_TOKEN=sk_test_your_stripe_test_key
PEAKA_CATALOG_ID=your_existing_peaka_catalog_id
PEAKA_SCHEMA_NAME=payment
NUM_CUSTOMERS=505   # your REAL customer count, not a guess
EXPECTED_CUSTOMER_COUNT_NON_CACHE=100
```

- **`PEAKA_API_KEY`** — from Peaka Studio's Developer section ([Partner API Key guide](https://docs.peaka.com/how-to-guides/how-to-manage-partner-api-key))
- **`PEAKA_PROJECT_ID`** — from your project's URL/settings in Peaka Studio
- **`STRIPE_TEST_TOKEN`** — a Stripe **test** secret key (`sk_test_...`); the suite refuses to run against a live key
- **`PEAKA_CATALOG_ID`** — an existing catalog already set up in Peaka Studio (created automatically alongside its connection). The `B` test reads this catalog's details directly rather than creating a new one each run.
- **`PEAKA_SCHEMA_NAME`** — the Stripe connector's schema name (e.g. `payment`) — used as a starting value; the `B` test cross-checks it against a live `listSchemas` call
- **`NUM_CUSTOMERS`** — your **real** customer count, used by `C`'s cache-comparison check
- **`EXPECTED_CUSTOMER_COUNT_NON_CACHE`** — the confirmed live-query cap value (default `100`), used by `C`'s live/uncached check as a deliberate regression test — see "Known gaps" below

⚠️ **`.env` contains secrets — don't commit it.** Add it to `.gitignore` if this goes into version control.

**Before running**, make sure your Stripe sandbox has seeded test data (customers, charges, subscriptions, invoices) for the `C`/`F` tests to check against.

## Run

```bash
npm test              # run once
npm test -- --watch   # watch mode
npx jest --ci          # also writes test-results/junit.xml (see jest.config.js)
```

Output looks like:

```
PASS jest/stripe/j-internal-tables.test.js    ✓ J: Internal Table Endpoints (3646 ms)
PASS jest/stripe/h-catalogs.test.js           ✓ H: Catalog Endpoints (3833 ms)
PASS jest/stripe/g-connections.test.js        ✓ G: Connection Endpoints (5184 ms)
PASS jest/stripe/k-exports.test.js            ✓ K: Export Endpoints (6879 ms)
PASS jest/stripe/i-queries.test.js            ✓ I: Saved Query Endpoints (7172 ms)
PASS jest/stripe/n-materialized-queries.test.js ✓ N: Materialized Query Endpoints (12382 ms)
PASS jest/stripe/l-metadata.test.js           ✓ L: Metadata Refresh Endpoints (14221 ms)
PASS jest/stripe/m-cache-management.test.js   ✓ M: Cache Management Endpoints (20619 ms)
PASS jest/stripe/connector.test.js
  ✓ A: Connection Setup (1621 ms)
  ✓ B: Catalog & Schema Discovery (4546 ms)
  ✓ C: Data Correctness & Cache Behavior (74248 ms)
  ✓ F: Error Handling & Edge Cases (5788 ms)

Test Suites: 11 passed, 11 total
Tests:       29 passed, 29 total
```

**Two different parallelism models are in play here, deliberately.** `A`/`B`/`C`/`F` live in one file as `test.concurrent()` blocks — concurrent promises sharing a single worker. `G` through `N` each live in their *own* file, so Jest schedules them across separate worker **processes**. The per-file layout is what makes each of those independently runnable (`npx jest -t "M: Cache Management Endpoints"`) and keeps them isolated from one another.

`C` still dominates wall time (~74s of ~85s): it runs every assertion twice with four cache syncs in between. Everything G–N runs alongside it, so they're nearly free in wall-clock terms.

## Web Dashboard (alternative to the CLI)

Prefer watching results in a browser instead of a terminal? Run:

```bash
npm install    # installs express, only needed for the dashboard
npm run web
```

Then open **http://localhost:3000**. It's a single persistent screen — the left sidebar shows a **folder tree** (like a file explorer), one collapsible section per folder, discovered dynamically by `server.js` scanning `tests/` for subfolders containing a `meta.js`.

There are two sections: **💳 Stripe** (12 scenarios) and **⚡ Concurrency Races** (3). The races folder is the first real proof the dynamic discovery works as designed rather than merely looking like it does — adding `tests/races/meta.js` was the *only* change needed for it to appear, with no edits to `server.js` or the frontend.

⚠️ **Never run the two folders at once.** The races deliberately manufacture conflicts and several cache `customers`, the same table Stripe's `C` caches. `server.js`'s `runInProgress` guard already blocks two overlapping dashboard runs, and `jest.config.js` excludes `jest/races/` so `npm test` can't pick them up — but starting `npm test` in a terminal while the races run in the browser would still collide. Click a section's header to expand/collapse it; each section has its own search box, "select all," and checkbox list, independent of any other folder's.

Inside the Stripe folder, the layout (based on a design mockup) is a 3-pane API-client-style view:

- **Left** — search + checkbox list of that folder's scenarios (name, step count, category)
- **Center** — "Test Results": one row per *currently selected* test, showing live status; click a row to inspect it
- **Right** — the selected test's status, duration, and (on failure) the real error message Jest reported

**Run All** selects everything and runs it; **Run Selected (N)** runs only the checked tests, using Jest's `testNamePattern` to filter to just those — still a real Jest invocation, just a scoped one.

**Important: this isn't a separate/alternate way of running the tests — it's the same Jest suite, actually invoked through it.** `server.js` calls Jest's own programmatic API (`runCLI` — the same function the `jest` CLI command itself calls under the hood), with a custom reporter (`jest/browserReporter.js`) that streams each `onTestCaseResult` to the browser over Server-Sent Events instead of just printing to a terminal.

**The right panel tracks each step live.** Step *names* come from `tests/stripe/meta.js` (so they're visible before a run happens), but each step's status and duration come from the real run: `helpers/step.js` emits `step-start` / `step-pass` / `step-fail` as it executes, and the heading counts completed steps (`Steps (5/8)`). The currently-running step pulses — which matters, since `C` can sit on a single cache-poll step for ~50s. Below that is the whole-scenario outcome: pass/fail badge, duration, and on failure the real Jest message, which already names the failing step.

A step listed in `meta.js` but never reported stays "pending" — so a stale `meta.js` is now visible rather than silent, which is useful given that file has drifted twice.

**How the step events get out of Jest.** This is the non-obvious part. `jest/browserReporter.js` can use the shared `jest/reporterBus.js` because Jest loads *reporters* itself, in the host process, via plain `require` — so the reporter and `server.js` genuinely share one module instance. **Test files get no such thing.** Everything a test requires goes through jest-runtime's sandboxed module registry, so requiring `reporterBus` from inside a test returns a *different* EventEmitter that `server.js` never sees. Scenarios `G`–`N` also live in separate files, which Jest may run in separate worker *processes*, where sharing a module instance is impossible by construction.

So step events travel over a localhost HTTP callback instead: `server.js` sets `PEAKA_STEP_REPORT_URL` before invoking Jest, `helpers/stepReporter.js` POSTs each event there, and the server re-emits it onto the same bus feeding the SSE stream. Under a plain `npm test` the variable is unset and every emit is a no-op, so the CLI is completely unaffected.

The scenario name is attached via **`AsyncLocalStorage`**, not a module-level variable. That matters for `jest/stripe/connector.test.js`, where four `test.concurrent()` blocks interleave inside one process — a shared "current scenario" would let their steps overwrite each other. Verified by running `A` and `F` concurrently and confirming no step landed under the wrong scenario.

⚠️ **Never run two suites against the same project at once.** Everything here drives real Jest runs against one Peaka project and the same tables, so overlapping runs contend for caches and API quota.

This has now bitten twice during development, both times looking exactly like a code regression:
- A stray `server.js` left running alongside `npm test` → 3× slowdown, four spurious failures.
- A dashboard race run, then `npm run test:races`, with a stray server still alive → **all three race tiers failed** and their times roughly doubled (Tier 1 407s vs 250s). Re-run in a quiet environment: all three green, unchanged code.

Two lessons worth keeping. **Times roughly doubling across files you didn't touch is the signature** — that pattern points at contention, not at your change. And on Windows, `pkill -f "node server.js"` from Git Bash does **not** reliably kill the process; check with PowerShell (`Get-CimInstance Win32_Process`) and confirm port 3000 is actually free.

Also note `npm run test:races | grep … && npm test` is a trap: `&&` sees *grep's* exit code, not Jest's, so the second suite runs even when the first failed — and then overlaps with whatever you start next.

**Keep `meta.js`'s step lists in sync with the actual `step(...)` calls in each test file.** This already caught a real bug once: `meta.js` had gone stale after `"resolve catalog name"` was added as a step to `C` and `F` (see the `resolveCatalogName` fix earlier), so its old `stepCount` field silently under-reported both (5 instead of 6, 2 instead of 3) until the step lists were rebuilt directly from the source files.

Also by design: no environment switcher (Staging/Production/Local) — this dashboard only ever talks to whatever's in your `.env`.

One real UX limitation worth knowing: Jest's reporter API doesn't expose a "this test is now running" hook at the individual test level — only a per-*file* start hook. For `A`/`B`/`C`/`F`, which share one file, that means all four show a spinner together the moment you click Run (an accurate approximation, since `test.concurrent()` genuinely starts them together). `G`–`N` each have their own file, so the per-file hook gives them individual start signals. In practice this matters much less now that steps report themselves — the first `step-start` is a precise "this scenario is actually working" signal regardless of what the reporter API offers.

**Credentials never reach the browser** — `server.js` reads `.env` itself; the browser only ever receives pass/fail results and error messages.

## What each test covers

| Test | Covers |
|---|---|
| **A: Connection Setup** | Creating a valid Stripe connection; cleanly rejecting an invalid token |
| **B: Catalog & Schema Discovery** | Reading the pre-existing catalog, discovering its schema, discovering core tables (`customers`, `charges`), verifying cache-capability flags, and checking expected columns on `customers`/`charges`/`subscriptions`/`invoices` |
| **C: Data Correctness & Cache Behavior** | Every count/distribution assertion run **twice** — once uncached, once served from cache — with the full cache lifecycle in between (create on all four data tables → poll to completion → verify `isCached`), plus non-cacheable rejection and duplicate-creation handling |
| **F: Error Handling & Edge Cases** | Querying a non-existent table, pagination correctness (no overlapping/missing rows across pages) |
| **G: Connection Endpoints** | Connection create/list/get/update/delete, the connector-config catalogue, and a **credential-masking check** asserting the Stripe key is never echoed back |
| **H: Catalog Endpoints** | Catalog create/list/delete against a throwaway catalog, project-wide search, and table statistics |
| **I: Saved Query Endpoints** | Saved-query CRUD plus SQL transpilation. Needs no catalog — a saved query's SQL is just stored text |
| **J: Internal Table Endpoints** | Peaka internal table and column create/list/delete |
| **K: Export Endpoints** | Async CSV export: start → poll to `SUCCEEDED` → read → list → cancel |
| **L: Metadata Refresh Endpoints** | Trigger a metadata refresh and poll it to a terminal state — against a catalog it creates itself |
| **N: Materialized Query Endpoints** | Create a materialized query, poll its status, list project-wide statuses, refresh, cancel, confirm it recovers, and the `inputQueryRefId` variant |
| **M: Cache Management Endpoints** | Cache settings read/update, batch creation, all three all-statuses variants, execution history, and the trigger/cancel pairs for incremental and full refresh |

**`C` and `D` used to be separate tests and were merged.** They interacted badly: creating a cache on a table the other test was querying live made the live count return `0`, because Peaka's query routing prefers an existing cache even mid-sync. Keeping them apart required `D` to deliberately avoid `C`'s tables. Merging removes the race outright — steps inside one test are plain sequential `await`s — and makes the live-vs-cached difference the *subject* of the test rather than a hazard to route around. It also cut resource churn: one test creating four caches, instead of two tests creating two caches on unrelated tables.

Each test runs its checks as a **plain sequential sequence of steps** inside one function (see `tests/*.js`) — not as separate, independently-run sub-tests. If an early step in a test fails, later steps in that same test don't run (normal function behavior), and the failure message is prefixed with which step it came from, e.g.:

```
✕ B: Catalog & Schema Discovery
  [list tables and check core tables present] Expected core tables missing...
```

## Why the 4 tests run concurrently, safely

All 4 tests use Jest's real `test.concurrent()` — genuinely running in parallel (verified: 5 synthetic 500ms-delay tests completed in ~715ms total, not ~2500ms+, confirming real overlap). This is safe here specifically because:

1. **Each test builds its own fresh `ctx`** (own `PeakaClient`, own tracking arrays) — nothing is shared or mutated across tests
2. **All cross-step ordering lives inside one test's function body** as plain `await` calls — not spread across separate `test()` declarations

That second point matters: an earlier version of this suite kept `B1-B4`/`D1-D6` as **separate** `test()` calls with a real dependency between them, and needed a `beforeAll`-based workaround because Jest's `test.concurrent()` doesn't reliably preserve declaration order relative to other tests (confirmed empirically with throwaway spike tests — a concurrent test declared *between* two sequential tests still finished before the first sequential one even started). Consolidating each category into one test removed that cross-test ordering requirement entirely, so `test.concurrent()` could finally be used the normal, documented way.

## Cleanup

Each test that creates real Peaka resources (connections in `A`, four caches in `C`) tracks them in its own `ctx`. `afterAll` cleans up everything across all 4 tests automatically once the run finishes.

To leave resources in place for inspection instead:

```bash
SKIP_CLEANUP=true npm test
```

## Structure

```
helpers/
  peakaClient.js       - thin wrapper over the Peaka Partner API
  assert.js            - lightweight assertion helpers
  step.js              - runs a named sub-step, tagging errors with which step failed
  env.js               - .env loader + credential validation
  cleanup.js           - resource-deletion logic (cache -> catalog -> connection)
  resolveCatalogName.js - resolves ctx.catalogName (live lookup + .env fallback)
  pollCacheUntilComplete.js - polls a cache's status until it completes or fails, shared by D and C's cache-comparison step
tests/
  stripe/                       - one folder per connector, auto-discovered by server.js
    meta.js                     - display name + scenario metadata for the dashboard
    a-connection-setup.js       - A: create/reject connections
    b-catalog-schema.js         - B: catalog -> schema -> tables -> cache flags -> columns
    c-data-and-cache.js         - C: uncached checks -> cache all 4 tables -> same checks cached -> edge cases
    f-error-handling.js         - F: non-existent table, pagination
jest/
  stripe/
    connector.test.js   - the 5 test.concurrent() blocks + afterAll cleanup
  browserReporter.js     - custom Jest reporter, streams onTestCaseResult onto reporterBus
  reporterBus.js         - shared EventEmitter used by browserReporter.js and server.js
public/
  index.html, styles.css, app.js - the web dashboard's frontend
server.js            - web dashboard entry point (Express, invokes Jest's runCLI, discovers connector folders dynamically)
jest.config.js       - test discovery, timeout, JUnit XML reporter
```

**Adding a new connector (e.g. Mongo) later:** create `tests/mongo/` with its own test files + a `meta.js` (see `tests/stripe/meta.js`), and `jest/mongo/connector.test.js` (see `jest/stripe/connector.test.js` as the pattern to copy). `server.js` discovers folders under `tests/` at request time by looking for a `meta.js` in each subfolder — no `server.js` or frontend changes needed; the new folder just appears as a card in the dashboard.

## Known gaps



**Endpoint paths are all verified now.** Seven paths in `helpers/peakaClient.js` used to be marked "best-effort / inferred from REST convention," because `docs.peaka.com` blocked deep-fetching those individual pages while this suite was built. The full endpoint index at [`docs.peaka.com/llms.txt`](https://docs.peaka.com/llms.txt) (linked from the API introduction page) works where the individual page fetches didn't — use it if you need to verify a new endpoint.

That check found **three genuinely wrong paths**, since corrected:

| Method | Was | Now |
|---|---|---|
| `triggerIncrementalUpdate` | `/cache/{id}/incremental` | `/cache/{id}/incrementalUpdate` |
| `triggerFullRefresh` | `/cache/{id}/full-refresh` | `/cache/{id}/fullRefreshUpdate` |
| `cancelFullRefresh` | `/cache/{id}/full-refresh/cancel` | `/cache/{id}/cancelFullRefreshUpdate` |

They had never failed visibly because no test calls those three methods yet. The other four previously-unconfirmed paths (`getCatalog`, `deleteCache`, `deleteConnection`, `deleteCatalog`) turned out to be exactly right, as did everything already marked confirmed (`createConnection`, `createCatalog`, `listSchemas`/`listTables`/`listColumns`, `createCache`, `executeQuery`, `getCacheStatus`).

`getCatalog` still has a built-in fallback — if it fails, `PEAKA_CATALOG_NAME` from `.env` is used instead. That fallback existed because the path was unverified; now that it's confirmed, a failure there means something genuinely wrong (bad `PEAKA_CATALOG_ID`, auth) and the fallback can mask it. Left in place for now, flagged in `helpers/resolveCatalogName.js`.

The corrected paths were verified against the live API, not just the docs, by calling each with a syntactically valid but non-existent `cacheId` (so nothing real got refreshed or cancelled). The distinction is clear-cut: the **old** paths return the generic framework "no route" 404 (`{"timestamp":..., "path":..., "error":"Not Found", "requestId":...}` — byte-identical in shape to a deliberately nonsense control path), while the **corrected** paths return real application-level handler errors that actually looked the cache up. A third docs-vs-behavior divergence turned up in the process: for a non-existent cache, `incrementalUpdate` and `fullRefreshUpdate` return **`400 WrongRequestException` "Cache settings not found"**, not the documented `404`. (`cancelFullRefreshUpdate` does return a proper `404`.) Minor, but it means don't write `assertStatus(res, 404, ...)` against those two on the strength of the docs alone.

Three genuine product-behavior findings from real testing against a live Peaka project:

1. **Duplicate cache creation returns `500` while the first sync is still running — reproducible on demand.**

   This was recorded for months as *inconsistent* behaviour: `500` once, `200` four times, across two tables, with the `500` written off as a one-off race worth investigating "if it recurs". It recurs every time. The behaviour isn't inconsistent — it's **state-dependent**:

   | Cache state when the duplicate `createCache` is attempted | Result |
   |---|---|
   | first sync still `RUNNING` | **`500 Internal Server Error`** |
   | first sync `COMPLETED` | `200` — silent get-or-create |

   Peaka's docs specify `409` for both cases. Reproduced deliberately on 2026-07-30 by creating a cache on `customers`, polling until `getCacheStatus` reported `RUNNING` (~2s), then firing a second `createCache` — `500` on the first attempt. Every historical observation fits: the lone `500` was noted as occurring mid-sync, and all four `200`s after completion. Nobody had deliberately re-entered the failing window.

   **Not destructive** — the original sync still reached `COMPLETED` (32s) and the cache deleted cleanly. So it's a bad response to a legitimate request rather than data loss.

   The suite's duplicate-create step runs *after* the sync completes, which is why it sees a clean `200`/`409` and accepts `[200, 409]`. A dedicated concurrency suite (`npm run test:races`, see `CONCURRENCY-SPEC.md`) now reproduces the mid-sync `500` deliberately and asserts it stays non-destructive.

   Two neighbouring races were tested at the same time and came back **clean**: `deleteCache` mid-sync returns `200` and correctly flips `isCached` to `false` with no orphan, and a simultaneous `triggerIncrementalUpdate` + `triggerFullRefresh` both return `200` and settle at `COMPLETED`. So the problem is specific to the *create* path, not to cache concurrency generally. Worth reporting upstream as: concurrent cache creation against an in-progress sync returns `500` rather than the documented `409`, reproducible in about two seconds.

2. **Live (uncached) queries cannot return more than 100 rows. Any of them — not just `COUNT(*)`.** Caching bypasses it completely.

   This is the most serious finding in this document, and it is worth stating precisely: **the Stripe connector silently returns partial result sets for ordinary data-fetching queries.** No error, no warning, no flag indicating the data is incomplete. Anything built on top of a live query is reading truncated data and cannot tell.

   Measured directly against `charges`, which has **652 real rows**, live and uncached (`isCached: false` verified immediately beforehand):

   | Query | Rows returned |
   |---|---|
   | `SELECT id … LIMIT 20` | 20 |
   | `SELECT id … LIMIT 100` | 100 |
   | `SELECT id … LIMIT 150` | **100** |
   | `SELECT id … LIMIT 250` | **100** |
   | `SELECT id … LIMIT 500` | **100** |

   Identical results through the query-builder request type, so it isn't specific to raw SQL. `100` matches Stripe's default List API page size — the likely cause is that Peaka isn't paginating through subsequent pages before returning.

   **One mechanism, three symptoms.** The scan stops at 100 rows; everything downstream inherits that:
   - `COUNT(*)` reports 100 because it counts a truncated scan.
   - A `WHERE` clause filters *the first 100 rows only* — refunded charges gives `18` live vs `85` cached, i.e. 18 of the first 100. This was originally recorded as a separate filter bug; it isn't one.
   - Row-fetching queries return at most 100 rows regardless of `LIMIT`.

   The count evidence across all four data tables, uncached then cached (same queries, caches created in between):

   | Table | live (uncached) | cached | real |
   |---|---|---|---|
   | `customers` | **100** | 505 | 505 |
   | `charges` | **100** | 652 | 652 |
   | `subscriptions` | **100** | 222 | 222 |
   | `invoices` | **100** | 338 | 338 |

   Every uncached count returns exactly `100` regardless of the table's real size.

   **Design note**: the live checks assert against `EXPECTED_CUSTOMER_COUNT_NON_CACHE` in `.env` (the *known cap value*, default `100`) rather than real counts — a deliberate **passing** regression test ("is the cap still exactly 100?") instead of a check designed to fail forever. If Peaka fixes the pagination bug these should start failing; that's the intended signal. Don't "fix" them by raising `EXPECTED_CUSTOMER_COUNT_NON_CACHE`. The cached pass separately asserts every table's count is *not* the cap value, so if the bug ever spreads to cached reads that surfaces immediately too. See `tests/stripe/c-data-and-cache.js`.

   **One assertion had to be replaced because of this.** The old invoice check expected "~25% of customers" and passed only because the cap clamped *both* sides to ~100. Against real data it's 338 invoices to 505 customers — 67%, nowhere near 25% — so it would have failed the moment it ran cached. Invoices are generated by subscriptions rather than by a flat percentage of customers, so it now asserts the relationship that actually holds: **at least one invoice per subscription** (338 to 222). Worth knowing that the original expectation was never validated against uncapped data.

   ✅ **Now asserted directly.** `C` checks both halves in one run: a live `SELECT id FROM charges LIMIT 500` returns exactly 100 rows on a 652-row table, and the same query once cached returns >100 (measured: 500) — both duplicate-free. The live assertion is a deliberate passing regression test against the known cap; the cached one would catch the truncation spreading to cached reads.

3. **Some Stripe connector tables produce cache jobs that hang forever, with no error and no way to detect it.** This is why the old `D: Cache Behavior` test was failing on every run.

   `D` picked "the first cacheable table that `C` doesn't touch." The Stripe catalog exposes 113 tables (97 cacheable), and the first one is `terminal_configurations` (Stripe **Terminal**); an earlier run landed on `issuing_fraud_liability_debits` (Stripe **Issuing**). Caches on those tables never complete, so `D` polled for ~100s and failed before reaching any of the checks it exists to perform.

   A controlled experiment across three tables isolates the cause:

   | Table | Rows | Result | Time |
   |---|---|---|---|
   | `refunds` | 85 | **COMPLETED** | 8.2s |
   | `transfers` | **0** | **COMPLETED** | 2.5s |
   | `terminal_configurations` | 1 | **RUNNING** | still running when abandoned at 314s |

   That rules out both obvious explanations: `transfers` is completely empty and finished in 2.5s, so it isn't emptiness; `refunds` did 85 rows in 8s and `customers` does 505 in under 50s, so it isn't volume.

   The failure mode is that **the execution record is created and then never touched again**:

   ```json
   {"status":"RUNNING","error":null,"progress":null,
    "createdAt":"2026-07-29T03:51:48.591Z",
    "updatedAt":"2026-07-29T03:51:48.591Z",
    "finishedAt":null}
   ```

   `updatedAt` is identical to `createdAt` and stayed that way across 20 polls over 5+ minutes — no error, no progress, no timeout, no transition to `FAILED`. The job is enqueued and never picked up, and **Peaka reports that indistinguishably from healthy in-progress work**. Any caller polling `getCacheStatus` has no way to tell "working" from "dead," which is what makes this worth reporting: not just that these tables fail, but that the failure is invisible.

   Related: `isCacheable: true` does not imply the table is even readable. `issuing_dispute_settlement_details` is advertised as cacheable but querying it returns a passed-through Stripe error, `"Unrecognized request URL (GET: /v1/issuing/dispute_settlement_details)"`.

   **What the test does now**: `C` (the merged test) caches exactly the four data tables it asserts on — `customers`, `charges`, `subscriptions`, `invoices` — all four verified to sync cleanly in ~37-50s. The arbitrary table-selection logic that caused this is gone entirely. The hang itself is deliberately **not** asserted anywhere — it's documented here rather than left as a permanently red test.

   Also found while investigating: the documented schema-level cache-status endpoint (`GET /data/projects/{projectId}/catalog/{catalogId}/schema/{schemaName}/cache/status`) returns **`500 Internal Server Error`** rather than a list of statuses.

### ⚠️ Deleting a cache can permanently break a table (encountered 2026-07-31)

**The most serious bug found so far, and it was hit by ordinary use — not by the deliberate race tests.**

After many routine cache create/delete cycles (`C` creates and deletes four caches every run), the shared catalog's `invoices` table entered a state it cannot leave:

| Probe | Result |
|---|---|
| `isTableCached(invoices)` | **`true`** |
| `getAllCacheStatusesOfProject` | **0 caches** |
| `getAllCacheStatusesOfCatalog` | **0 caches** |
| Live `SELECT` on `invoices` | **`400`** — `Table 'peaka.bitable.tableacc15ada…' does not exist` |
| `createCache(invoices)` | **`400`** — `Cannot create a table on a non-empty location: s3a://schemamapper…` |
| `createCacheBatch(invoices)` | `success: false`, same Iceberg error |

Peaka believes the table is cached, exposes no cache to delete, refuses to re-cache it, and routes queries to an Iceberg table that no longer exists. **The table is unreachable through Peaka.**

The damage is confined to that one table in that one catalog — `customers`, `charges`, `subscriptions`, `refunds` and `transfers` all query fine, and `invoices` caches perfectly in a *freshly created* catalog, so Stripe and the connector are healthy.

**No API-side recovery exists.** Tried and failed: metadata refresh (no effect, and the refresh itself never reached a terminal state in 80s), catalog- and project-level status listings (both empty), `createCache`, and `createCacheBatch`. Repair requires Peaka Studio or Peaka support.

This is the orphaned-cache scenario `CONCURRENCY-SPEC.md` gates Tier 2 #4 behind an opt-in to avoid — *"can strand a cache that no endpoint enumerates"*. It turned out not to need the risky test at all. The most likely trigger is a cache delete interrupted mid-sync: a dashboard server died during a run earlier the same day, leaving four orphaned caches that were then deleted manually.

**Worth reporting upstream as:** cache deletion can leave a catalog's table pointing at a dropped Iceberg table, breaking both reads and re-caching, with `isCached` still reporting `true` and no API handle to clear it.

**Not reproducible on demand.** Six deliberate attempts in a throwaway catalog all came back healthy: delete mid-sync then re-create; six normal create/settle/delete cycles; delete before `RUNNING` appears; provoking the mid-sync duplicate-create `500` then re-creating; `deleteCache` and `createCache` fired concurrently; and two concurrent creates on a cold table. So the `500` does *not* leave the location dirty, and neither does concurrent create/delete — whatever triggers this needs a rarer condition. Two useful by-products: a create issued *during* a delete returns `500` (a fourth `500` path, non-destructive), and two concurrent creates on a cold table both return `200`.

**So it is detected rather than reproduced.** `C`'s first step now cross-checks `isTableCached` against the catalog's cache listing. A table reporting `isCached: true` while **no cache is listed** is a contradiction Peaka should never produce, and it is this corruption's exact signature. The check costs one extra API call and fails in **3.6s with a diagnosis**, where previously the problem surfaced ~48s later as an opaque Iceberg error several steps removed from the cause. Verified both ways: it fires on the real corrupted `invoices`, and stays quiet when a legitimate cache exists.

### Smaller API quirks found while covering the base endpoints

None of these are severe on their own, but each one silently breaks naive client code, and several
contradict the published reference:

| Behaviour | Detail |
|---|---|
| **Two spellings of "cancelled"** | Cache statuses use `CANCELLED` (two L's); materialized query statuses use `CANCELED` (one L). A polling loop handling only one spelling waits forever on the other — this bit the materialized-query test during development and looked exactly like a hang |
| **Deleted resources return `400`, not `404`** | Both `getQuery` and `getConnection` on a deleted id return `400` with an explanatory message. The instructor's STRIPE-02 scenario expects `404` |
| **`COMPLETED` doesn't mean "materialized"** | A freshly created materialized query reports `status: COMPLETED` with `lastExecutionStartTime` and `lastUpdateTime` both `null`. It means "nothing in flight", not "the data exists" |
| **Stale status after triggering a refresh** | The status endpoint keeps returning the *previous* terminal status until the new run actually starts, so polling for "any terminal status" right after a refresh returns the old value instantly |
| **Malformed cache schedules are silently ignored** | `PUT /cache/{id}` with an invalid ISO-8601 expression returns `200` and keeps the old schedule, instead of the documented `400` |
| **Table statistics unsupported for Stripe** | `400 "Catalog type: stripe is not being supported yet"` |
| **`transpileSql` returns `{query}`** | The reference documents `{result}` |
| **Metadata refresh status is lower-kebab** | Returns `not-active`; the reference documents `NOT_ACTIVE` |
| **Executing a saved query keys off `id`** | Not `queryId`. `queryId`, `queryRefId` and `savedQueryId` all return `400`, as does passing the id as a JSON number |

## Pairwise test generation with the real Microsoft PICT

`helpers/pictWrapper.js` shells out to the **actual Microsoft PICT binary** (not a reimplementation) to generate combinatorial test coverage - e.g. combinations of `Table` × `CacheSchedule` × `QueryFormat` × `QueryMechanism` that would be impractical to test exhaustively (162 full combinations → ~21 pairwise-covering rows, independently verified to still cover every pair).

**The binaries in `tools/pict/` are real, unmodified Microsoft artifacts**:
- `pict.exe` - the official Windows release (v3.7.4), downloaded directly from `github.com/microsoft/pict/releases`
- `pict-linux` - built from Microsoft's own source (`github.com/microsoft/pict`) via `make pict`, for CI (GitHub Actions runs on `ubuntu-latest`)

`helpers/pictWrapper.js` auto-detects the platform (`process.platform`) and calls whichever binary is correct - no code changes needed switching between your local Windows machine and CI.

There's also a from-scratch JS reimplementation of the same algorithm in `helpers/pairwiseGenerate.js` - built and benchmarked against the real tool before the real-binary integration existed. Both are kept: the real binary is the actual, authoritative Microsoft tool; the homemade version has zero external dependencies and needs no platform-specific binary at all. Either can be used as the generator - they produce comparably-sized, fully pair-covering output (18 vs. 21 rows on our real project's dimensions, both independently verified to cover all 81 required pairs).

**What's not yet done**: the generator itself works, but nothing in `tests/stripe/*.js` yet *uses* the generated combinations to drive real `createCache`/`executeQuery` calls against Peaka - that's the natural next step, not yet built. Note: dedicated unit tests for these generators were removed (see below) - if they get wired into a real scenario, correctness will be covered by that scenario's own assertions instead.



A GitHub Actions workflow (`.github/workflows/nightly-test.yml`) runs the real suite (`npm test` — same Jest suite as everything above, nothing different for CI) on a **schedule** rather than on every push/PR — this suite mostly catches Peaka/Stripe-side drift (real API behavior changing), not code regressions in this repo, so time-based cadence matters more than commit-triggered runs. It also adds a manual "Run workflow" button (`workflow_dispatch`) for on-demand runs.

### Required GitHub secrets

Add these under your repo's **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `PEAKA_API_KEY` | Your Peaka Partner API key |
| `PEAKA_PROJECT_ID` | Your Peaka project ID |
| `STRIPE_TEST_TOKEN` | A Stripe **test** secret key |
| `PEAKA_CATALOG_ID` | Your existing catalog's ID |
| `PEAKA_SCHEMA_NAME` | e.g. `payment` |
| `NUM_CUSTOMERS` | Your real Stripe sandbox customer count |
| `EXPECTED_CUSTOMER_COUNT_NON_CACHE` | The known live-query cap (`100`) |
| `SLACK_WEBHOOK_URL` | Optional — if unset, the workflow just skips Slack notification and logs that it did, rather than failing |

No `.env` file needed in CI — `helpers/env.js` already prioritizes real environment variables over `.env`, so these secrets are picked up automatically.

**Strongly recommended: use a dedicated Stripe/Peaka project for automated runs**, separate from your own manual testing. This suite already fixed one real resource-collision bug (`C` and `D` racing over the same table when run concurrently) — running scheduled automation against the same project you're also manually poking at reintroduces that same class of risk, just between a human and a bot instead of two tests.

### Why this workflow does NOT use `jest.retryTimes()`

Deliberately avoided. Jest's built-in retry re-runs a failing test and reports only the result of the **last** attempt — the first failure's data gets thrown away entirely. That's a real, documented flakiness anti-pattern (see e.g. Mergify's writeup on this), and it's in direct conflict with what this suite has been doing throughout its development: several genuine Peaka product findings in this README (the duplicate-cache `500`/`200` discrepancy, the `COUNT(*)` cap) were only caught *because* nothing silently retried and hid the first failure.

Instead, the workflow runs the suite once, and — **only if it fails** — runs it again as a fully separate, fully visible step. Both attempts' `junit.xml` results get uploaded as artifacts regardless of outcome. The Slack notification distinguishes three real outcomes:

- **Clean pass on attempt 1** → no notification at all, nothing to look at
- **Failed once, passed on retry** → notified anyway, explicitly labeled "flaky, not fixed, worth investigating" — this is the case `retryTimes()` would have hidden completely
- **Failed both times** → notified as a real, reproducible failure, job marked red

This keeps the exact "a failure should mean something real" philosophy the rest of this suite already follows, rather than trading it away for a quieter CI dashboard.
