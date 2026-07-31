# Peaka × Stripe Connector — Test Coverage

Eleven scenarios. `B`/`C`/`F` share `jest/stripe/connector.test.js` and run concurrently via `test.concurrent()`; `G`-`N` each have their own `jest/stripe/<name>.test.js` so Jest runs them in separate worker processes. All step logic lives in `tests/stripe/*.js` — see the README's "Why the tests run concurrently, safely" section for why the shared-file ones are safe.

**`A: Connection Setup` no longer exists.** It was merged into `G: Connection Endpoints` on 2026-07-31: both scenarios covered connections, and A's "create a valid connection" step asserted a strict subset of what G's first step already asserts (id present, `type: stripe`) before going on to prove the connection is listable, readable, updatable and deletable. Only A's invalid-token check tested something G didn't, so that step moved to G and A was deleted rather than left duplicating coverage.

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
| Live SELECT capped at 100 | `SELECT id FROM charges LIMIT 500` on a 652-row table | Exactly 100 rows, duplicate-free. This is the form that actually corrupts data for a caller: an ordinary fetch silently returns a partial result set with no error and no flag |
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
| Cached SELECT exceeds 100 | `SELECT id FROM charges LIMIT 500`, now cached | Returns >100 (measured: 500), duplicate-free. The only context in which a >100-row result is obtainable at all |
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

## G-N: Base API endpoint coverage

One simple test per endpoint, with scope taken from Peaka's own API reference rather than a summary list. Each of these lives in its own test file, creates whatever resources it needs, and deletes them again.

| Scenario | Endpoints | Notes |
|---|---|---|
| **G: Connection Endpoints** | create, list, get, update, delete, list/get connector config | Absorbed the former `A: Connection Setup`, so it also covers invalid-token handling. Includes a **credential-masking** check: the serialized `getConnection` body is scanned for the raw token and for `sk_`/`rk_` prefixes. Deletion is asserted (Peaka returns `400`, not `404`) |
| **H: Catalog Endpoints** | catalog create/list/delete, project search, table statistics | Uses a throwaway catalog; explicitly re-asserts that `PEAKA_CATALOG_ID` survived. Table statistics returns `400 "Catalog type: stripe is not being supported yet"` - asserted as known behaviour |
| **I: Saved Query Endpoints** | query create/list/read/update/delete, SQL transpile | Needs no catalog. Transpile returns `{query}` though the docs say `{result}` - both accepted |
| **J: Internal Table Endpoints** | table create/list/delete, column add/list/delete | Project-level, no catalog needed |
| **K: Export Endpoints** | export create/read/list/cancel | Async: create returns **202**, cancel returns **204**. Polls to `SUCCEEDED`, then asserts a downloadable file URL. Cancel is called twice to check documented idempotency |
| **L: Metadata Refresh Endpoints** | refresh, refresh status | Runs against a catalog it creates itself - refreshing the shared one would disturb `B` and `C`. Status comes back lower-kebab (`not-active`) though docs say `NOT_ACTIVE`; normalised before comparison |
| **N: Materialized Query Endpoints** | create (via `queryType: MATERIALIZED`), read status, list statuses, refresh, cancel | A materialized query is just a saved query, so it is created/deleted through the ordinary query endpoints; `inputQueryRefId` is optional. Peaka spells this status **`CANCELED`** (one L) while cache statuses use `CANCELLED` (two) - a polling loop handling only one spelling hangs on the other. A *fresh* materialized query reports `COMPLETED` with null timestamps, meaning "nothing in flight", not "materialized" |
| **M: Cache Management Endpoints** | settings get/update, batch create, all-statuses x3, execution history, trigger/cancel incremental + full refresh, delete | The first tests to call the four cache endpoints whose paths were corrected in PR #3. Schedule updates are a config round-trip, not a wait-for-fire. A malformed expression returns `200` and is silently ignored rather than the documented `400` - the test asserts the garbage is never *persisted*. The schema-level all-statuses variant returns `500` (known) |

## Extending

Add a new step to the relevant category's `run*()` function in `tests/stripe/*.js`, wrapped in `step("description", async () => {...})` from `helpers/step.js` — this tags any thrown error with which step produced it, so a failure in a multi-step test still tells you exactly what broke.

If a genuinely new, independent category is needed (not fitting A/B/C/D/F), add a new `tests/stripe/<letter>-<name>.js` file exporting a `run<Name>(ctx)` function, then add a `test.concurrent(...)` block for it in `jest/stripe/connector.test.js` — following the same pattern (fresh `ctx`, `requireCredentials()`, add to the `afterAll` cleanup list). **Also update `tests/stripe/meta.js`'s step list in the same change** — it drives the dashboard and has drifted stale twice.

**Before caching a new table in any test, check no other test queries it live.** That is exactly the collision that forced the `C`/`D` merge, and `F`'s pagination step had to move off `charges` for the same reason.
