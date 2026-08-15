# Peaka × Stripe Connector Test Suite — Project Handoff

> ⚠️ **OUTDATED — predates HubSpot and the dashboard rework.** This snapshot was written when the suite
> was Stripe-only and the web dashboard read a single static project from `.env`. Since then: a HubSpot
> connector was added (see `tests/hubspot/`), and the dashboard became a real multi-project app with its
> own Connect screen, a killable/Stop-able run, and hardened security posture (see `README.md`'s "The web
> dashboard" section — that is the current source of truth, not this file). Sections 1-2 and 8 below
> describe the *old* architecture and should not be trusted for how the dashboard works today; sections 3,
> 6, 7 and 9 (the Peaka product findings, CI notes, gotchas, and next steps) are still accurate and worth
> reading. Kept for the historical reasoning, not as a current architecture reference.

**Purpose of this document**: everything needed to pick up this project cold, in a new environment or a new AI session, without having to reconstruct the reasoning behind decisions from scratch. Written after an extensive, iterative build process — the "why" behind each choice matters as much as the "what."

---

## 1. What this project actually is

A Jest test suite that validates Peaka's Stripe connector against the **real** Peaka Partner API and a seeded Stripe test sandbox. Not mocked — every test makes genuine network calls. Built incrementally, with most architectural decisions driven by things that were *tried and found not to work*, not designed upfront.

**Run it**: `npm install`, fill in `.env` with real credentials, `npm test`.

---

## 2. Current architecture (and why it's shaped this way)

### Consolidated tests, not many small ones
`B: Catalog & Schema Discovery`, `C: Data Correctness & Cache Behavior`, `F: Error Handling` — each is ONE Jest `test.concurrent()` block that internally runs several named `step(...)` calls in sequence.

**`A: Connection Setup` was merged into `G: Connection Endpoints`** (2026-07-31). Both covered connections, and A's "create a valid connection" step asserted a strict subset of G's first step. Only A's invalid-token check was unique, so it moved to G and A was deleted.

**`C` and `D` were later merged into one test** (2026-07-29). They interacted: caching a table the other was querying live made the live count return 0, which `D` worked around by avoiding `C`'s tables. Merged, the race is impossible and the live-vs-cached difference becomes the subject of the test — every correctness assertion runs twice, uncached then cached, with the cache lifecycle in between. 20 steps, ~74s. See `tests/stripe/c-data-and-cache.js`.

**Why consolidated**: originally had 21 separate scenarios. The user explicitly asked to consolidate them ("I am not interested in testing endpoints one by one") specifically so `test.concurrent()` could be used safely — Jest's scheduler does **not** reliably preserve declaration order between `test.concurrent()` blocks and regular sequential tests (confirmed via a throwaway spike test: a concurrent test declared *between* two sequential ones finished before the first sequential one even started). Consolidating removed all *cross-test* ordering dependencies, so there's nothing left for Jest's scheduler to get wrong.

### Each test builds its own independent `ctx`
`ctx` is just a plain JS object (`{ client, catalogId, schemaName, createdCacheIds: [], ... }`), built fresh inside each `test.concurrent()` block via `buildFreshCtx()` in `jest/stripe/connector.test.js`. **Not shared** between `A`/`B`/`C`/`F` — this is what makes running them concurrently safe.

### `helpers/step.js` wraps sequential sub-steps within one test
Each test's internal steps (e.g. `B` has 8: read catalog → list schemas → list tables → check cache flags → 4× list columns) run as plain sequential `await step("name", fn)` calls. If one throws, the error message gets prefixed with which step failed. This is a real, intentional dependency chain *within* one test — different from the (removed) cross-test dependencies.

### Web dashboard actually invokes real Jest, not a separate code path
`server.js` calls Jest's own `runCLI()` (the same function the `jest` CLI binary calls) with a custom reporter (`jest/browserReporter.js`) streaming results to the browser via a shared `EventEmitter` (`jest/reporterBus.js`) + Server-Sent Events. **Not** a duplicate test-running system — clicking "Run" in the browser runs the literal same Jest suite as `npm test`.

**Real bug found while building this**: tried passing a live callback function through `runCLI()`'s config object — silently failed, because `runCLI` JSON-serializes its config internally, and `JSON.stringify` drops function properties without any error. Fixed by using a shared `EventEmitter` module instead (same-process communication, no serialization needed).

**Live per-step reporting uses a different channel, and the reason is worth internalising.** The shared `EventEmitter` works for the *reporter* because Jest loads reporters itself, in the host process. **Test code cannot use it**: everything a test requires goes through jest-runtime's sandboxed module registry, so `require("../reporterBus")` inside a test returns a different instance than `server.js` holds — and scenarios `G`-`N` may run in separate worker processes entirely. So `helpers/step.js` POSTs step events to a localhost endpoint (`PEAKA_STEP_REPORT_URL`, set by `server.js`), which re-emits them onto the bus. Unset under `npm test`, so the CLI is unaffected. The scenario name rides on `AsyncLocalStorage` rather than a module global, because the four `test.concurrent()` blocks in `connector.test.js` interleave in one process and would otherwise clobber each other's context.

### Connector folders are dynamically discovered, not hardcoded
`tests/stripe/meta.js` describes that connector's display name, icon, and scenario list (name/category/steps). `server.js`'s `discoverConnectors()` scans `tests/` for subfolders containing a `meta.js` at request time. **Verified this is genuinely dynamic**, not just organized-to-look-dynamic: temporarily created a fake `tests/mongo-test-proof/meta.js` mid-project, confirmed it appeared as a second folder card with zero code changes, then removed it. It has since been proven for real — `tests/races/meta.js` added the ⚡ Concurrency Races folder to the dashboard with no `server.js` or frontend edits at all, which is the design paying off rather than a rehearsal.

**To add a new connector** (Mongo, Supabase, etc.): create `tests/<name>/` with test files + a `meta.js` (copy `tests/stripe/meta.js`'s shape), and `jest/<name>/connector.test.js` (copy `jest/stripe/connector.test.js`'s pattern — own `ctx`, `test.concurrent()`, `afterAll` cleanup). No `server.js` or frontend changes needed.

---

## 3. Real product findings (Peaka bugs, not test bugs)

These are documented in code comments (`tests/stripe/c-data-and-cache.js`) and the README's "Known gaps" section — worth re-reading directly, this is just a summary:

1. **Live (uncached) queries cannot return more than 100 rows — any query, not just `COUNT(*)`.** Caching bypasses it completely. This is the most consequential finding in the project: the connector **silently returns partial result sets** for ordinary data fetching, with no error or flag, so anything built on a live query reads truncated data and can't tell.
   - Measured against `charges` (652 real rows), live, `isCached:false` verified first: `LIMIT 20`→20, `LIMIT 100`→100, `LIMIT 150`→**100**, `LIMIT 250`→**100**, `LIMIT 500`→**100**. Same through the builder request type, so not raw-SQL-specific. 100 = Stripe's default List API page size.
   - **One mechanism, three symptoms.** The scan stops at 100 and everything downstream inherits it: `COUNT(*)` counts a truncated scan; a `WHERE` clause filters only the first 100 rows (refunded charges 18 live vs 85 cached); row fetches cap at 100 regardless of `LIMIT`. The filtered-count case was originally written up as a separate filter bug — it isn't one.
   - Count evidence across all four tables in a single run, uncached then cached: `customers` 100→505, `charges` 100→652, `subscriptions` 100→222, `invoices` 100→338.
   - **Both forms are asserted now.** `C` checks `COUNT(*)` *and* row retrieval in one run: a live `SELECT id FROM charges LIMIT 500` returns exactly 100 on a 652-row table, and the same query cached returns >100 (measured 500), both duplicate-free. The live side is a passing regression test against the known cap; the cached side would catch the truncation spreading to cached reads.
   - The live steps assert against the **known cap value** (`EXPECTED_CUSTOMER_COUNT_NON_CACHE`, default `100`) — a passing regression test ("is the cap still exactly 100?"), not a check designed to fail forever. The cached steps separately assert each count is *not* the cap, so if the bug ever reaches cached reads that surfaces immediately.
   - **A bogus assertion fell out of this.** The old invoice check expected "~25% of customers" and passed only because the cap clamped both sides to ~100. Real data is 338 invoices to 505 customers (67%). Invoices come from subscriptions, not a flat customer percentage, so it now asserts at least one invoice per subscription (338 to 222).

2. **Duplicate cache creation returns `500` while the first sync is still running — now reproducible on demand.** Recorded for months as *inconsistent* (`500` once, `200` four times) with the `500` dismissed as a one-off race. It isn't inconsistent, it's **state-dependent**: mid-sync → `500`; after the sync completes → `200` (silent get-or-create). Docs specify `409` for both. Reproduced deliberately 2026-07-30 — create a cache on `customers`, poll until `getCacheStatus` says `RUNNING` (~2s), fire a second `createCache` → `500` on the first attempt. Every historical observation fits once you account for cache state; nobody had re-entered the failing window on purpose. **Not destructive** — the original sync still reached `COMPLETED` and the cache deleted cleanly. The suite's duplicate-create step runs post-sync, which is why it sees a clean `200`/`409`.

3. **A real concurrency bug in Peaka's query routing, found through this suite's own architecture**: running `D` (creating a cache on `customers`) concurrently with `C` (querying `customers` live) caused `C`'s count to return `0` instead of the real value, in the exact window the new cache was still syncing. Best explanation: Peaka's query routing prefers an existing (even still-empty, still-syncing) cache over a live Stripe call once one exists for that table. **Originally fixed at the test-design level** by having `D` select a cacheable table `C` never touches. That workaround is now obsolete: `C` and `D` are one test, so there is no concurrency between them to protect against, and the merged test asserts the routing behavior directly via the `isCached` endpoint instead of steering around it.

4. **Some Stripe tables produce cache jobs that hang forever, invisibly** — the reason `D` failed on every run for a while. `D` originally took "the first cacheable table `C` doesn't touch," which is arbitrary: the catalog has 113 tables (97 cacheable) and the first is `terminal_configurations` (Stripe Terminal), with `issuing_fraud_liability_debits` (Stripe Issuing) in an earlier run. A controlled three-table experiment settled it — `refunds` (85 rows) completed in 8.2s, `transfers` (**0 rows**) in 2.5s, `terminal_configurations` (1 row) was still `RUNNING` at 314s. So neither emptiness nor volume explains it. The execution record gets created and then **never touched again**: `updatedAt` stays byte-identical to `createdAt`, `progress` stays `null`, `error` stays `null`, and it never transitions to `FAILED`. Peaka reports a dead job identically to a healthy one, so polling `getCacheStatus` cannot distinguish them. That selection logic is gone entirely now that `C`/`D` are merged — the merged test caches exactly the four tables it asserts on (`customers`, `charges`, `subscriptions`, `invoices`), all verified to sync cleanly in ~37-50s. The hang is documented in the README, deliberately **not** asserted anywhere — no permanently red test. Two side findings from the same investigation: `isCacheable: true` doesn't imply readable (`issuing_dispute_settlement_details` returns a Stripe `"Unrecognized request URL"` error), and the documented schema-level cache-status endpoint returns `500`.

---

## 4. Current file structure (as of this handoff)

```
.env                              - credentials (placeholder values in the shipped version)
.github/workflows/nightly-test.yml - scheduled CI (see section 6)
README.md                          - full documentation, keep this in sync with any changes
STRIPE_TEST_SCENARIOS.md           - per-test-category breakdown of what each step checks
package.json                       - scripts: test, test:watch, web

helpers/
  peakaClient.js          - thin wrapper over the Peaka Partner API (all endpoint paths now
                             verified against docs.peaka.com/llms.txt - see file header)
  assert.js                - lightweight assertion helpers (assert, assertStatus, assertStatusIn, assertApprox, assertEqual, assertIncludes)
  step.js                  - runs a named sub-step, tags thrown errors with which step failed
  env.js                   - .env loader + credential validation (detects placeholder values too)
  cleanup.js                - deletes tracked resources (cache -> catalog -> connection order)
  resolveCatalogName.js     - resolves ctx.catalogName (live getCatalog call + .env fallback)
  pollCacheUntilComplete.js - polls a cache's status until done/failed
  cacheExecution.js         - reads a cache's true current status (see FINDINGS.md)
  buildCtx.js               - builds each scenario's isolated context
  stepReporter.js           - emits live step events to the dashboard (no-op under npm test)
  raceWindow.js             - timing primitives for the concurrency suite
  racePreflight.js          - refuses to start the races if another run is active

tests/stripe/
  meta.js                   - connector metadata (displayName, icon, scenarios[].steps) - KEEP
                              IN SYNC with actual step() calls in the files below (this has
                              already drifted stale twice - see section 7)
  b-catalog-schema.js        - B: catalog -> schema -> tables -> cache flags -> columns (8 steps)
  c-data-and-cache.js        - C: uncached checks -> cache all 4 tables -> same checks cached ->
                               live-vs-cached comparison -> cache edge cases (20 steps)
  g-connections.js           - G: connection CRUD + connector config + credential masking (9)
  h-catalogs.js              - H: catalog CRUD + search + table statistics (6)
  i-queries.js               - I: saved-query CRUD + execute by id/name + transpile (8)
  j-internal-tables.js       - J: Peaka table + column CRUD (6)
  k-exports.js               - K: async CSV export create/poll/read/list/cancel (6)
  l-metadata.js              - L: metadata refresh + status, on its own catalog (5)
  m-cache-management.js      - M: settings, batch, all-statuses x3, history, trigger/cancel (17)
  n-materialized-queries.js  - N: materialized create/status/refresh/cancel/recover (9)
                               G-N each have their own jest/stripe/<name>.test.js
  f-error-handling.js        - F: non-existent table, pagination (3 steps)

jest/
  stripe/connector.test.js  - the 3 test.concurrent() blocks (B, C, F), buildFreshCtx(), afterAll cleanup
  browserReporter.js         - custom Jest reporter streaming results onto reporterBus
  reporterBus.js             - shared EventEmitter, browserReporter.js + server.js both use it

public/
  index.html, styles.css, app.js - web dashboard frontend (see section 8 for design provenance)

server.js                    - Express server, calls Jest's real runCLI(), dynamic folder discovery
```

---

## 5. Pairwise generation (removed from the repo)

Two combinatorial generators were built — a from-scratch JS implementation and a wrapper around the
real Microsoft PICT binary — but **neither was ever wired into a test scenario**, so nothing consumed
their output. They were untracked on 2026-07-31 along with `PAIRWISE-SPEC.md` and
`STATE-MACHINE-SPEC.md`, and remain in git history if they are ever wanted back.

`STATE-MACHINE-SPEC.md` went the same way for a stronger reason: its central argument was that the
duplicate-create `500` had never been reproduced and nothing explored sequencing. The concurrency
suite now reproduces it deterministically in Tier 1.1, so `CONCURRENCY-SPEC.md` supersedes it.

---

## 6. CI automation

`.github/workflows/nightly-test.yml` — runs on a **schedule** (default 6am UTC daily) plus manual trigger, not on every push/PR, since this suite mostly catches Peaka/Stripe-side drift, not code regressions in this repo.

**Deliberately does NOT use `jest.retryTimes()`.** That API discards the first failure's data and reports only the last attempt — directly in conflict with this project's whole approach (the duplicate-cache and `COUNT(*)`-cap findings were only caught because nothing silently retried past them). Instead: run once, retry once **only on failure**, keep both attempts' `junit.xml` results as artifacts regardless of outcome, and distinguish in the Slack notification between "clean pass" (silent), "flaky — passed on retry" (notified, investigate), and "genuinely failed twice" (notified, job fails).

**Required GitHub secrets** (see README for the full table): `PEAKA_API_KEY`, `PEAKA_PROJECT_ID`, `STRIPE_TEST_TOKEN`, `PEAKA_CATALOG_ID`, `PEAKA_SCHEMA_NAME`, `EXPECTED_CUSTOMER_COUNT_NON_CACHE`, optionally the `PEAKA_PG_*` trio and `SLACK_WEBHOOK_URL`. (`NUM_CUSTOMERS` was removed — the real count is now read from Stripe's own API.)

Dedicated unit tests (`jest/unit/`) were deliberately removed — this suite is scoped to the credentialed integration tests only now, so there's no separate fast/free tier to split CI around.

---

## 7. Known gotchas worth knowing before continuing

- **`tests/stripe/meta.js`'s step lists have already drifted stale twice** — both `C` and `F` gained a `"resolve catalog name"` step when the catalog-name bug got fixed, but `meta.js` wasn't updated at the same time. If you add/remove/rename a `step(...)` call in any `tests/stripe/*.js` file, update `meta.js` in the same change.
- **Jest's per-test timeout matters for anything that polls a cache to completion** — `C` and `D` both got `120000` (120s) as their `test.concurrent()`'s third argument, since `pollCacheUntilComplete` can take up to ~100s worst case (20 attempts × 5s). `C` originally didn't have this override and started timing out at Jest's 30s default the moment its own cache-comparison step was added — if you add a new slow step to any test, check whether its timeout needs raising too.
- **Don't leave stale duplicate files behind after restructuring.** When files moved from flat `tests/*.js` + `jest/stripe-connector.test.js` into nested `tests/stripe/*.js` + `jest/stripe/connector.test.js`, old copies were left behind locally on one occasion and caused real, confusing failures (Jest picked up both old and new, the old ones crashed on stale import paths). If you ever restructure file locations again, explicitly delete the old ones, don't just add the new ones alongside.
- **To verify a Peaka endpoint, use `docs.peaka.com/llms.txt`, not individual doc pages.** Deep-fetching specific `api-reference/...` pages is what failed early on and left seven paths in `peakaClient.js` marked "best-effort" for months; three of them were in fact wrong (`/incremental`, `/full-refresh`, `/full-refresh/cancel` — see the README's "Known gaps" for the corrections). `llms.txt` is the complete endpoint index and fetches fine, and each entry's `.md` page fetches fine too once you have its exact URL from there. There's also an OpenAPI spec at `docs.peaka.com/api-reference/peaka-openapi.json`.
- **Peaka's cache status enum is exactly `NOT_INITIALIZED` / `RUNNING` / `COMPLETED` / `FAILED` / `CANCELLED` / `DELETED`.** `helpers/pollCacheUntilComplete.js` originally treated only `FAILED` as terminal-failure, so a cancelled or deleted cache polled the full ~100s and then reported a misleading generic timeout. If you touch that poller, keep both sets matched to this enum rather than guessing at plausible-sounding extra values.
- **Don't pick connector tables by "first one that matches a flag."** `D` did this and spent multiple runs failing against Stripe Terminal/Issuing tables whose caches never complete (see finding #4 above). The Stripe catalog's obscure tables sort early, and `isCacheable: true` is not a promise the table is readable, let alone syncable. When a test needs "some table of type X," name the specific tables you mean instead — the merged `C` caches exactly the four tables it asserts on, which is both deterministic and self-documenting.

---

## 8. Web dashboard design provenance

The current 3-pane layout (folder tree in the left sidebar / center results list / right detail panel) was built from a Claude Design mockup (`API Test Runner.dc.html`) the user shared via an exported handoff package — colors (`oklch(...)` values), fonts (Inter + JetBrains Mono), and spacing were matched directly from that file's inline styles, then adapted: the design's per-step Request/Response/Headers tabs were **deliberately not built** (would require instrumenting `tests/stripe/*.js` to capture real request/response data per step, not just pass/fail) — the right panel currently shows a static step-name list (from `meta.js`) plus the real error message on failure, not live per-step data. Later, the design's separate "landing page" folder browser was replaced with an inline, VS-Code-style collapsible tree section directly in the left sidebar, per explicit follow-up feedback — no more full-page navigation between folders.

---

## 9. Clear next steps, roughly in order of natural progression

1. **Tighten the remaining hedged status assertions** — roughly a dozen `assertStatusIn([...])` calls in `tests/stripe/*.js` accept a set where a single value was measured. See FINDINGS.md's "bugs in this test suite" section: a hedge of exactly this shape concealed a broken wait for as long as the step existed.
2. **A second connector** (Mongo/Supabase) — the folder-discovery architecture is ready for this with zero core changes; would be the first real test of whether the "generic" design actually holds up.
3. **Real per-step live tracking** in the web dashboard, if the request/response detail view becomes valuable enough to justify instrumenting `tests/stripe/*.js` further.
4. Revisit the "interaction testing" ideas discussed at length (deliberately combining operations that touch the same resource, beyond the one `C`/`D` collision already found and fixed) — genuinely promising territory, but explicitly *not yet built*, since the discussion concluded that hand-picking a small, targeted "conflict matrix" of plausible pairs is more tractable than exhaustive or fully-randomized concurrent combination testing given real API rate limits and cost.
