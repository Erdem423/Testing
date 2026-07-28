# Peaka × Stripe Connector Test Suite — Project Handoff

**Purpose of this document**: everything needed to pick up this project cold, in a new environment or a new AI session, without having to reconstruct the reasoning behind decisions from scratch. Written after an extensive, iterative build process — the "why" behind each choice matters as much as the "what."

---

## 1. What this project actually is

A Jest test suite that validates Peaka's Stripe connector against the **real** Peaka Partner API and a seeded Stripe test sandbox. Not mocked — every test makes genuine network calls. Built incrementally, with most architectural decisions driven by things that were *tried and found not to work*, not designed upfront.

**Run it**: `npm install`, fill in `.env` with real credentials, `npm test`.

---

## 2. Current architecture (and why it's shaped this way)

### Five consolidated tests, not many small ones
`A: Connection Setup`, `B: Catalog & Schema Discovery`, `C: Data Correctness`, `D: Cache Behavior`, `F: Error Handling` — each is ONE Jest `test.concurrent()` block that internally runs several named `step(...)` calls in sequence.

**Why consolidated**: originally had 21 separate scenarios. The user explicitly asked to consolidate them ("I am not interested in testing endpoints one by one") specifically so `test.concurrent()` could be used safely — Jest's scheduler does **not** reliably preserve declaration order between `test.concurrent()` blocks and regular sequential tests (confirmed via a throwaway spike test: a concurrent test declared *between* two sequential ones finished before the first sequential one even started). Consolidating removed all *cross-test* ordering dependencies, so there's nothing left for Jest's scheduler to get wrong.

### Each test builds its own independent `ctx`
`ctx` is just a plain JS object (`{ client, catalogId, schemaName, createdCacheIds: [], ... }`), built fresh inside each `test.concurrent()` block via `buildFreshCtx()` in `jest/stripe/connector.test.js`. **Not shared** between `A`/`B`/`C`/`D`/`F` — this is what makes running them concurrently safe.

### `helpers/step.js` wraps sequential sub-steps within one test
Each test's internal steps (e.g. `B` has 8: read catalog → list schemas → list tables → check cache flags → 4× list columns) run as plain sequential `await step("name", fn)` calls. If one throws, the error message gets prefixed with which step failed. This is a real, intentional dependency chain *within* one test — different from the (removed) cross-test dependencies.

### Web dashboard actually invokes real Jest, not a separate code path
`server.js` calls Jest's own `runCLI()` (the same function the `jest` CLI binary calls) with a custom reporter (`jest/browserReporter.js`) streaming results to the browser via a shared `EventEmitter` (`jest/reporterBus.js`) + Server-Sent Events. **Not** a duplicate test-running system — clicking "Run" in the browser runs the literal same Jest suite as `npm test`.

**Real bug found while building this**: tried passing a live callback function through `runCLI()`'s config object — silently failed, because `runCLI` JSON-serializes its config internally, and `JSON.stringify` drops function properties without any error. Fixed by using a shared `EventEmitter` module instead (same-process communication, no serialization needed).

### Connector folders are dynamically discovered, not hardcoded
`tests/stripe/meta.js` describes that connector's display name, icon, and scenario list (name/category/steps). `server.js`'s `discoverConnectors()` scans `tests/` for subfolders containing a `meta.js` at request time. **Verified this is genuinely dynamic**, not just organized-to-look-dynamic: temporarily created a fake `tests/mongo-test-proof/meta.js` mid-project, confirmed it appeared as a second folder card with zero code changes, then removed it.

**To add a new connector** (Mongo, Supabase, etc.): create `tests/<name>/` with test files + a `meta.js` (copy `tests/stripe/meta.js`'s shape), and `jest/<name>/connector.test.js` (copy `jest/stripe/connector.test.js`'s pattern — own `ctx`, `test.concurrent()`, `afterAll` cleanup). No `server.js` or frontend changes needed.

---

## 3. Real product findings (Peaka bugs, not test bugs)

These are documented in code comments (`tests/stripe/c-data-correctness.js`, `tests/stripe/d-cache-behavior.js`) and the README's "Known gaps" section — worth re-reading directly, this is just a summary:

1. **`COUNT(*)` queries are capped at exactly 100 rows** for live (non-cached) queries against the Stripe connector, regardless of the table's real size — matches Stripe's default List API page size exactly. Confirmed on two different tables (`customers`: 505 real rows → returns 100; `invoices`: same pattern). Likely cause: Peaka's `COUNT(*)` isn't paginating through all pages before aggregating.
   - `C`'s `"customer count matches seed"` step now deliberately asserts against this **known cap value** (`EXPECTED_CUSTOMER_COUNT_NON_CACHE` in `.env`, default `100`) — a passing regression test ("is the cap still exactly 100?"), not a check designed to fail forever.
   - `C`'s `"customer count via completed cache"` step tests the follow-up question — does caching bypass the cap? — by creating its own cache, waiting for it to sync, and comparing against the *real* count (`NUM_CUSTOMERS`).

2. **Duplicate cache creation doesn't match documented behavior.** Peaka's docs say creating a cache for a table that already has one returns `409`. Real observed behavior, 5 times across 2 tables: `500` once (when the original cache was still `RUNNING` — likely a genuine race condition server-side), `200` the other 4 times (returning the existing cache's config unchanged — silent get-or-create). `D`'s duplicate-check step now accepts `[200, 409]` but **not** `500` (that one's still a real server error worth investigating if it recurs).

3. **A real concurrency bug in Peaka's query routing, found through this suite's own architecture**: running `D` (creating a cache on `customers`) concurrently with `C` (querying `customers` live) caused `C`'s count to return `0` instead of the real value, in the exact window the new cache was still syncing. Best explanation: Peaka's query routing prefers an existing (even still-empty, still-syncing) cache over a live Stripe call once one exists for that table. **Fixed at the test-design level**, not by adding artificial ordering: `D` now dynamically selects a cacheable table that `C` never touches (`tests/stripe/d-cache-behavior.js`'s `"select a cache-target table"` step, excluding `customers`/`charges`/`subscriptions`/`invoices`), so the two tests can never collide regardless of how Jest schedules them.

---

## 4. Current file structure (as of this handoff)

```
.env                              - credentials (placeholder values in the shipped version)
.github/workflows/nightly-test.yml - scheduled CI (see section 6)
README.md                          - full documentation, keep this in sync with any changes
STRIPE_TEST_SCENARIOS.md           - per-test-category breakdown of what each step checks
package.json                       - scripts: test, test:watch, web

helpers/
  peakaClient.js          - thin wrapper over the Peaka Partner API (some endpoint paths are
                             best-effort/unconfirmed - see file header comments)
  assert.js                - lightweight assertion helpers (assert, assertStatus, assertStatusIn, assertApprox, assertEqual, assertIncludes)
  step.js                  - runs a named sub-step, tags thrown errors with which step failed
  env.js                   - .env loader + credential validation (detects placeholder values too)
  cleanup.js                - deletes tracked resources (cache -> catalog -> connection order)
  resolveCatalogName.js     - resolves ctx.catalogName (live getCatalog call + .env fallback)
  pollCacheUntilComplete.js - polls a cache's status until done/failed, shared by D and C
  pairwiseGenerate.js       - homemade pairwise-combination generator (JS reimplementation of PICT's algorithm)
  pictWrapper.js            - wraps the REAL Microsoft PICT binary (see section 5)

tests/stripe/
  meta.js                   - connector metadata (displayName, icon, scenarios[].steps) - KEEP
                              IN SYNC with actual step() calls in the files below (this has
                              already drifted stale twice - see section 7)
  a-connection-setup.js      - A: create/reject Stripe connections (2 steps)
  b-catalog-schema.js        - B: catalog -> schema -> tables -> cache flags -> columns (8 steps)
  c-data-correctness.js      - C: seeded-data checks + live-vs-cached count comparison (7 steps)
  d-cache-behavior.js        - D: create -> poll -> non-cacheable rejection -> duplicate handling (5 steps)
  f-error-handling.js        - F: non-existent table, pagination (3 steps)

jest/
  stripe/connector.test.js  - the 5 test.concurrent() blocks, buildFreshCtx(), afterAll cleanup
  browserReporter.js         - custom Jest reporter streaming results onto reporterBus
  reporterBus.js             - shared EventEmitter, browserReporter.js + server.js both use it

public/
  index.html, styles.css, app.js - web dashboard frontend (see section 8 for design provenance)

server.js                    - Express server, calls Jest's real runCLI(), dynamic folder discovery
tools/pict/
  pict.exe                   - REAL Microsoft PICT binary, official Windows release v3.7.4
  pict-linux                 - REAL Microsoft PICT, built from source, for CI (ubuntu-latest)
```

---

## 5. The two pairwise-generation implementations (both real, both kept deliberately)

- **`helpers/pairwiseGenerate.js`** — a from-scratch greedy pairwise-covering algorithm in plain JS, zero dependencies. Verified: on the project's real dimensions (Table × CacheSchedule × QueryFormat × QueryMechanism — 162 full combinations), produces 18 rows, independently confirmed to cover all 81 required pairs. Benchmarked against a known published Microsoft PICT example (5 binary params, published result 7 rows) — this implementation got 6, comparable quality.

- **`helpers/pictWrapper.js`** — shells out to the **actual** Microsoft PICT binary (not a reimplementation). Built by cloning `github.com/microsoft/pict`, running `make pict` for the Linux binary, and downloading the official pre-built `pict.exe` from the GitHub releases page for Windows. Auto-detects `process.platform` to pick the right binary. On the same real dimensions, the actual tool produces 21 rows (vs. the homemade version's 18) — both fully valid, different algorithms land on different but equally-correct minimal-ish sets.

**Neither is yet wired into an actual test scenario.** Both generate lists of combinations — nothing in `tests/stripe/*.js` currently *uses* either generator's output to drive real `createCache`/`executeQuery` calls against Peaka. That's the clear, well-scoped next step if picking this back up.

**Real bug found and fixed while building `pairwiseGenerate.js`**: with only one parameter, there are no *pairs* possible at all, so the original version returned zero rows even though you'd obviously want each value tested at least once. Fixed with a fallback pass ensuring every individual value appears in at least one row, regardless of parameter count.

**Real gotcha hit while packaging the PICT binaries**: the destination folder used for building the final zip turned out to be a FUSE-mounted remote filesystem that silently doesn't honor `chmod` — the Linux binary's executable bit kept disappearing. Fixed by building the entire zip in a normal filesystem first, then copying only the *finished* zip file over (a zip's internal permission metadata survives independent of the outer filesystem). If you hit "permission denied" running `pict-linux` after extracting a zip, re-`chmod +x` it — some zip tools/OSes don't reliably preserve the Unix executable bit across platforms (Windows especially, since it has no native concept of the bit at all).

---

## 6. CI automation

`.github/workflows/nightly-test.yml` — runs on a **schedule** (default 6am UTC daily) plus manual trigger, not on every push/PR, since this suite mostly catches Peaka/Stripe-side drift, not code regressions in this repo.

**Deliberately does NOT use `jest.retryTimes()`.** That API discards the first failure's data and reports only the last attempt — directly in conflict with this project's whole approach (the duplicate-cache and `COUNT(*)`-cap findings were only caught because nothing silently retried past them). Instead: run once, retry once **only on failure**, keep both attempts' `junit.xml` results as artifacts regardless of outcome, and distinguish in the Slack notification between "clean pass" (silent), "flaky — passed on retry" (notified, investigate), and "genuinely failed twice" (notified, job fails).

**Required GitHub secrets** (see README for the full table): `PEAKA_API_KEY`, `PEAKA_PROJECT_ID`, `STRIPE_TEST_TOKEN`, `PEAKA_CATALOG_ID`, `PEAKA_SCHEMA_NAME`, `NUM_CUSTOMERS`, `EXPECTED_CUSTOMER_COUNT_NON_CACHE`, optionally `SLACK_WEBHOOK_URL`.

Dedicated unit tests (`jest/unit/`, covering `helpers/pairwiseGenerate.js` and `helpers/pictWrapper.js`) were deliberately removed — this suite is scoped to the credentialed integration tests only now, so there's no separate fast/free tier to split CI around.

---

## 7. Known gotchas worth knowing before continuing

- **`tests/stripe/meta.js`'s step lists have already drifted stale twice** — both `C` and `F` gained a `"resolve catalog name"` step when the catalog-name bug got fixed, but `meta.js` wasn't updated at the same time. If you add/remove/rename a `step(...)` call in any `tests/stripe/*.js` file, update `meta.js` in the same change.
- **Jest's per-test timeout matters for anything that polls a cache to completion** — `C` and `D` both got `120000` (120s) as their `test.concurrent()`'s third argument, since `pollCacheUntilComplete` can take up to ~100s worst case (20 attempts × 5s). `C` originally didn't have this override and started timing out at Jest's 30s default the moment its own cache-comparison step was added — if you add a new slow step to any test, check whether its timeout needs raising too.
- **Don't leave stale duplicate files behind after restructuring.** When files moved from flat `tests/*.js` + `jest/stripe-connector.test.js` into nested `tests/stripe/*.js` + `jest/stripe/connector.test.js`, old copies were left behind locally on one occasion and caused real, confusing failures (Jest picked up both old and new, the old ones crashed on stale import paths). If you ever restructure file locations again, explicitly delete the old ones, don't just add the new ones alongside.

---

## 8. Web dashboard design provenance

The current 3-pane layout (folder tree in the left sidebar / center results list / right detail panel) was built from a Claude Design mockup (`API Test Runner.dc.html`) the user shared via an exported handoff package — colors (`oklch(...)` values), fonts (Inter + JetBrains Mono), and spacing were matched directly from that file's inline styles, then adapted: the design's per-step Request/Response/Headers tabs were **deliberately not built** (would require instrumenting `tests/stripe/*.js` to capture real request/response data per step, not just pass/fail) — the right panel currently shows a static step-name list (from `meta.js`) plus the real error message on failure, not live per-step data. Later, the design's separate "landing page" folder browser was replaced with an inline, VS-Code-style collapsible tree section directly in the left sidebar, per explicit follow-up feedback — no more full-page navigation between folders.

---

## 9. Clear next steps, roughly in order of natural progression

1. **Wire the pairwise generators into an actual test** — pick either `pairwiseGenerate.js` or `pictWrapper.js`, generate real combinations of `Table`/`CacheSchedule`/`QueryFormat`/`QueryMechanism`, and write a new step (in `tests/stripe/` or a new category) that runs a real `createCache`/`executeQuery` for each generated row and asserts a general property (e.g. "never a raw 500"). Note: their old dedicated unit tests were removed, so correctness would need to come from this new scenario's own assertions.
2. **A second connector** (Mongo/Supabase) — the folder-discovery architecture is ready for this with zero core changes; would be the first real test of whether the "generic" design actually holds up.
3. **Real per-step live tracking** in the web dashboard, if the request/response detail view becomes valuable enough to justify instrumenting `tests/stripe/*.js` further.
4. Revisit the "interaction testing" ideas discussed at length (deliberately combining operations that touch the same resource, beyond the one `C`/`D` collision already found and fixed) — genuinely promising territory, but explicitly *not yet built*, since the discussion concluded that hand-picking a small, targeted "conflict matrix" of plausible pairs is more tractable than exhaustive or fully-randomized concurrent combination testing given real API rate limits and cost.
