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
NUM_CUSTOMERS=500
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
PASS jest/stripe/connector.test.js
  ✓ A: Connection Setup
  ✓ B: Catalog & Schema Discovery
  ✓ C: Data Correctness
  ✓ D: Cache Behavior
  ✓ F: Error Handling & Edge Cases
```

## Web Dashboard (alternative to the CLI)

Prefer watching results in a browser instead of a terminal? Run:

```bash
npm install    # installs express, only needed for the dashboard
npm run web
```

Then open **http://localhost:3000**. It's a single persistent screen — the left sidebar shows a **folder tree** (like a file explorer), one collapsible section per connector, discovered dynamically by `server.js` scanning `tests/` for subfolders containing a `meta.js` (not hardcoded — verified by temporarily adding a second fake folder during development and watching it appear as a second tree section with zero code changes, then removing it again). Currently there's one section: **Stripe**. Click a section's header to expand/collapse it; each section has its own search box, "select all," and checkbox list, independent of any other folder's.

Inside the Stripe folder, the layout (based on a design mockup) is a 3-pane API-client-style view:

- **Left** — search + checkbox list of all 5 tests (name, step count, category)
- **Center** — "Test Results": one row per *currently selected* test, showing live status; click a row to inspect it
- **Right** — the selected test's status, duration, and (on failure) the real error message Jest reported

**Run All** selects everything and runs it; **Run Selected (N)** runs only the checked tests, using Jest's `testNamePattern` to filter to just those — still a real Jest invocation, just a scoped one.

**Important: this isn't a separate/alternate way of running the tests — it's the same Jest suite, actually invoked through it.** `server.js` calls Jest's own programmatic API (`runCLI` — the same function the `jest` CLI command itself calls under the hood), with a custom reporter (`jest/browserReporter.js`) that streams each `onTestCaseResult` to the browser over Server-Sent Events instead of just printing to a terminal.

**The right panel shows each scenario's steps as a static, informational list** (name only — not run individually, not tracked pass/fail per step, no request/response data), sourced from `tests/stripe/meta.js`. Below that, the real run outcome: pass/fail badge, duration, and (on failure) the actual failure message Jest reported, which already names which step failed (e.g. `"[list tables and check core tables present] Expected ..."`).

**Known simplification, deliberate for now:** there's no *live* per-step tracking (no individual "step 3 of 8 is currently running" indicator, no per-step request/response viewer) — only the whole-scenario pass/fail is tracked live. Building live per-step tracking would mean instrumenting `tests/stripe/*.js` to report each step's real status/duration/request/response as it happens, not just its name upfront. Deferred deliberately rather than faking placeholder data.

**Keep `meta.js`'s step lists in sync with the actual `step(...)` calls in each test file.** This already caught a real bug once: `meta.js` had gone stale after `"resolve catalog name"` was added as a step to `C` and `F` (see the `resolveCatalogName` fix earlier), so its old `stepCount` field silently under-reported both (5 instead of 6, 2 instead of 3) until the step lists were rebuilt directly from the source files.

Also by design: no environment switcher (Staging/Production/Local) — this dashboard only ever talks to whatever's in your `.env`.

One real UX limitation worth knowing: Jest's reporter API doesn't expose a "this test is now running" hook at the individual test level (only a per-*file* start hook, and we only have one file) — so all selected tests show a spinner together the moment you click Run (an accurate approximation, since `test.concurrent()` genuinely starts them together), transitioning to pass/fail as each `onTestCaseResult` arrives individually.

**Credentials never reach the browser** — `server.js` reads `.env` itself; the browser only ever receives pass/fail results and error messages.

## What each test covers

| Test | Covers |
|---|---|
| **A: Connection Setup** | Creating a valid Stripe connection; cleanly rejecting an invalid token |
| **B: Catalog & Schema Discovery** | Reading the pre-existing catalog, discovering its schema, discovering core tables (`customers`, `charges`), verifying cache-capability flags, and checking expected columns on `customers`/`charges`/`subscriptions`/`invoices` |
| **C: Data Correctness** | Customer/charge/subscription/invoice counts and distributions against what the seed script is expected to have produced |
| **D: Cache Behavior** | Creating a cache, polling its status to completion, rejecting cache creation on a non-cacheable table, rejecting a duplicate cache on the same table |
| **F: Error Handling & Edge Cases** | Querying a non-existent table, pagination correctness (no overlapping/missing rows across pages) |

Each test runs its checks as a **plain sequential sequence of steps** inside one function (see `tests/*.js`) — not as separate, independently-run sub-tests. If an early step in a test fails, later steps in that same test don't run (normal function behavior), and the failure message is prefixed with which step it came from, e.g.:

```
✕ B: Catalog & Schema Discovery
  [list tables and check core tables present] Expected core tables missing...
```

## Why the 5 tests run concurrently, safely

All 5 tests use Jest's real `test.concurrent()` — genuinely running in parallel (verified: 5 synthetic 500ms-delay tests completed in ~715ms total, not ~2500ms+, confirming real overlap). This is safe here specifically because:

1. **Each test builds its own fresh `ctx`** (own `PeakaClient`, own tracking arrays) — nothing is shared or mutated across tests
2. **All cross-step ordering lives inside one test's function body** as plain `await` calls — not spread across separate `test()` declarations

That second point matters: an earlier version of this suite kept `B1-B4`/`D1-D6` as **separate** `test()` calls with a real dependency between them, and needed a `beforeAll`-based workaround because Jest's `test.concurrent()` doesn't reliably preserve declaration order relative to other tests (confirmed empirically with throwaway spike tests — a concurrent test declared *between* two sequential tests still finished before the first sequential one even started). Consolidating each category into one test removed that cross-test ordering requirement entirely, so `test.concurrent()` could finally be used the normal, documented way.

## Cleanup

Each test that creates real Peaka resources (connections in `A`, a cache in `D`) tracks them in its own `ctx`. `afterAll` cleans up everything across all 5 tests automatically once the run finishes.

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
    c-data-correctness.js       - C: seeded-data checks
    d-cache-behavior.js         - D: create -> poll status -> non-cacheable -> duplicate
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

1. **Duplicate cache creation doesn't match documented behavior - now accepted as confirmed behavior, not a failure.** Reproduced five times across two different tables (`customers`, `promotion_codes`): `500 Internal Server Error` once, when the original cache's sync was still `RUNNING`; `200 OK` (returning the existing cache's config unchanged) in every other observation, once the original cache had completed. Peaka's docs document `409`. After five consistent reproductions of `200`, the test now accepts `[200, 409]` rather than failing on every run - real, repeatable get-or-create behavior, not something worth a red test forever. `500` is still NOT accepted (that single observation happened during an actual race condition and is a genuine server error, worth investigating if it recurs). See the comment in `tests/d-cache-behavior.js` for the full history. Still worth mentioning to whoever owns the cache-creation service, since the docs and behavior disagree - just no longer something this suite treats as a failure.

2. **`COUNT(*)` queries appear hard-capped at exactly 100 rows.** Confirmed on two different tables: a `customers` table with 505 real rows (per the Stripe dashboard) consistently returns exactly `100`; an `invoices` count check with a 100-customer expectation also returned exactly `100` when the real count should have been ~25% of that. `100` matches Stripe's default List API page size - the likely cause is that Peaka's `COUNT(*)` isn't paginating through all pages before aggregating. See the comment in `tests/stripe/c-data-correctness.js`.

   **Design note**: `"customer count matches seed"` (the live/uncached check) now deliberately asserts against `EXPECTED_CUSTOMER_COUNT_NON_CACHE` in `.env` (the *known cap value*, default `100`) rather than your real customer count (`NUM_CUSTOMERS`) - this turns it into a passing regression test ("is the live-query cap still exactly 100?") instead of a check designed to fail forever. If Peaka ever fixes the underlying pagination bug, this check should start failing - that's the intended signal, don't "fix" it by raising `EXPECTED_CUSTOMER_COUNT_NON_CACHE` to match your real count instead. Meanwhile `"customer count via completed cache"` still compares against your *real* count (`NUM_CUSTOMERS`) to test whether caching bypasses the cap - see that step's comment for the full reasoning.

3. **Some Stripe connector tables produce cache jobs that hang forever, with no error and no way to detect it.** This is the most serious of the three, and it's why `D: Cache Behavior` was failing on every run.

   `D` used to pick "the first cacheable table that `C` doesn't touch." The Stripe catalog exposes 113 tables (97 cacheable), and the first one is `terminal_configurations` (Stripe **Terminal**); an earlier run landed on `issuing_fraud_liability_debits` (Stripe **Issuing**). Caches on those tables never complete, so `D` polled for ~100s and failed before reaching any of the checks it exists to perform.

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

   **What the test does now**: `D` picks from an ordered list of known-good core Stripe tables (`refunds`, `transfers`, `payouts`, ...) that `C` doesn't touch, falling back to the old "first cacheable" behavior with a loud warning if none are present. That makes `D` deterministic and fast (~8s instead of a 100s timeout) and gets it back to testing cache behavior. The hang itself is deliberately **not** asserted anywhere — it's documented here rather than left as a permanently red test.

   Also found while investigating: the documented schema-level cache-status endpoint (`GET /data/projects/{projectId}/catalog/{catalogId}/schema/{schemaName}/cache/status`) returns **`500 Internal Server Error`** rather than a list of statuses.

   A follow-up check, `"customer count via completed cache"`, tests whether this cap is specific to *live* (non-cached) queries - it creates its own cache on `customers` (independent of D's cache; each scenario has its own `ctx`), waits for it to finish syncing via the shared `helpers/pollCacheUntilComplete.js` helper, then re-counts and compares against both the live count and the real expected count. Whichever way that comes out is useful information - if the cached count is still capped at ~100, the bug is broader than just live pass-through queries.

## Pairwise test generation with the real Microsoft PICT

`helpers/pictWrapper.js` shells out to the **actual Microsoft PICT binary** (not a reimplementation) to generate combinatorial test coverage - e.g. combinations of `Table` × `CacheSchedule` × `QueryFormat` × `QueryMechanism` that would be impractical to test exhaustively (162 full combinations → ~21 pairwise-covering rows, independently verified to still cover every pair - see `jest/unit/pictWrapper.test.js`).

**The binaries in `tools/pict/` are real, unmodified Microsoft artifacts**:
- `pict.exe` - the official Windows release (v3.7.4), downloaded directly from `github.com/microsoft/pict/releases`
- `pict-linux` - built from Microsoft's own source (`github.com/microsoft/pict`) via `make pict`, for CI (GitHub Actions runs on `ubuntu-latest`)

`helpers/pictWrapper.js` auto-detects the platform (`process.platform`) and calls whichever binary is correct - no code changes needed switching between your local Windows machine and CI.

There's also a from-scratch JS reimplementation of the same algorithm in `helpers/pairwiseGenerate.js` (with its own unit tests in `jest/unit/pairwiseGenerate.test.js`) - built and benchmarked against the real tool before the real-binary integration existed. Both are kept: the real binary is the actual, authoritative Microsoft tool; the homemade version has zero external dependencies and needs no platform-specific binary at all. Either can be used as the generator - they produce comparably-sized, fully pair-covering output (18 vs. 21 rows on our real project's dimensions, both independently verified to cover all 81 required pairs).

**What's not yet done**: the generator itself works and is fully tested, but nothing in `tests/stripe/*.js` yet *uses* the generated combinations to drive real `createCache`/`executeQuery` calls against Peaka - that's the natural next step, not yet built.



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
