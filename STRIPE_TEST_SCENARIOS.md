# Peaka × Stripe Connector — Test Coverage

Four Jest tests (`jest/stripe/connector.test.js`), each running a sequence of internal steps (see `tests/stripe/*.js`). All 4 run concurrently via `test.concurrent()` — see the README's "Why the 4 tests run concurrently, safely" section for why that's safe.

## A: Connection Setup

| Step | What it does | Expected result |
|---|---|---|
| Create valid connection | POST `/connections/{projectId}` with `type: stripe`, valid `sk_test_` token | 200, response includes `id`, `type: stripe` |
| Reject invalid token | Same, with a garbage token | 4xx error, or a 200 with a note to verify it fails downstream |

## B: Catalog & Schema Discovery

A real internal dependency chain — each step needs the previous one's output.

| Step | What it does | Expected result |
|---|---|---|
| Read pre-existing catalog | GET `/data/projects/{projectId}/catalogs/{catalogId}` using `PEAKA_CATALOG_ID` | 200, `catalogType: stripe`, includes queryable `name` |
| List schemas | GET schemas for the catalog | Includes the expected schema (`PEAKA_SCHEMA_NAME`) |
| List tables | GET tables for the schema | Includes at minimum `customers`, `charges` |
| Verify cache flags | Inspect `isCacheable`/`supportedCacheTypes` on `customers` | `isCacheable: true`, supports at least one cache type |
| List columns (×4) | GET columns for `customers`, `charges`, `subscriptions`, `invoices` | Each includes its expected fields (e.g. `customer_id`, not `customer` — confirmed from a real Peaka response) |

## C: Data Correctness & Cache Behavior

Merged from the former separate `C: Data Correctness` and `D: Cache Behavior`. They were two concurrent tests that interfered with each other — caching a table the other was querying live returned 0 rows — so `D` had to deliberately avoid `C`'s tables. As one test the race is impossible, and the live-vs-cached difference becomes the point rather than a hazard.

The ordering is load-bearing: **all uncached assertions must run before anything is cached**, because the live checks measure Peaka's 100-row cap on live reads and a cached table has no live query left to measure it with. (That cap applies to *any* live query, not just `COUNT(*)` — a `SELECT ... LIMIT 500` also returns 100. See Known Gaps in the README.)

### Phase 1 — uncached

| Step | What it does | Expected result |
|---|---|---|
| Resolve catalog name | `getCatalog`, falling back to `PEAKA_CATALOG_NAME` | A queryable catalog slug |
| Tables all start uncached | `isCached` on all four data tables | All `false`; if any is `true` (leftover cache) the live phase is skipped with a clear log rather than failing |
| Live counts capped at 100 | `COUNT(*)` on customers/charges/subscriptions/invoices | Every one returns exactly `EXPECTED_CUSTOMER_COUNT_NON_CACHE` (100) — a deliberate passing regression test for the cap |
| Live charge refund distribution | Refunded vs total charges | ~15% (wide tolerance; measured over a capped 100-row sample) |
| Live subscription distribution | active/canceled counts | Some present, and active+canceled ≤ total |
| Live spot check | A specific seeded customer by name | Email matches what was seeded |

### Phase 2 — cache lifecycle

| Step | What it does | Expected result |
|---|---|---|
| Create caches | `createCache` on all four data tables | 200 (or 409), cache id returned for each |
| Poll to completion | All four polled **in parallel** via `pollCacheUntilComplete` | All reach `COMPLETED` (~37-50s in parallel, not the sum) |
| Verify cached | `isCached` on all four | All now `true` — turns "was this served from cache?" from an assumption into an assertion |

### Phase 3 — cached

| Step | What it does | Expected result |
|---|---|---|
| Cached counts bypass the cap | Same `COUNT(*)` queries again | None returns exactly 100; all non-zero. Failing here would mean the cap reaches cached reads too — a broader bug, deliberately not tolerated |
| Cached customer count | vs `NUM_CUSTOMERS` | ≈ real count (505) |
| Cached charge refund distribution | Refunded vs total, full table | ~15% |
| Cached subscription distribution | active/canceled | active+canceled ≤ total |
| Cached invoice count | vs subscriptions | ≥ 1 invoice per subscription. (Replaces an old "~25% of customers" check that only ever passed because the cap clamped both sides — real ratio is 67%) |
| Cached spot check | Same customer, now from cache | Same name/email as the live pass — caching must not alter field values |
| Live vs cached summary | Logs every metric side by side | Informational |

### Phase 4 — cache edge cases

| Step | What it does | Expected result |
|---|---|---|
| Non-cacheable rejection | `createCache` on a table with `isCacheable: false` | 400, `errorCode: TABLE_NOT_CACHEABLE` |
| Duplicate creation | `createCache` again on `customers` | 200 or 409 — real behavior is get-or-create (200), not the documented 409; see Known Gaps in README |

## F: Error Handling & Edge Cases

| Step | What it does | Expected result |
|---|---|---|
| Non-existent table | Query a table that doesn't exist | Clean 4xx, not a crash |
| Pagination | Query `refunds` with `limit/offset` across two pages | No overlapping/missing rows between pages. Deliberately **not** `charges` — `C` caches that table, and querying it mid-sync returns 0 rows, which this step's empty-page guard would silently read as "no seed data" and skip |

## Extending

Add a new step to the relevant category's `run*()` function in `tests/stripe/*.js`, wrapped in `step("description", async () => {...})` from `helpers/step.js` — this tags any thrown error with which step produced it, so a failure in a multi-step test still tells you exactly what broke.

If a genuinely new, independent category is needed (not fitting A/B/C/D/F), add a new `tests/stripe/<letter>-<name>.js` file exporting a `run<Name>(ctx)` function, then add a `test.concurrent(...)` block for it in `jest/stripe/connector.test.js` — following the same pattern (fresh `ctx`, `requireCredentials()`, add to the `afterAll` cleanup list). **Also update `tests/stripe/meta.js`'s step list in the same change** — it drives the dashboard and has drifted stale twice.

**Before caching a new table in any test, check no other test queries it live.** That is exactly the collision that forced the `C`/`D` merge, and `F`'s pagination step had to move off `charges` for the same reason.
