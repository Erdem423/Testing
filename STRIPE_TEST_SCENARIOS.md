# Peaka × Stripe Connector — Test Coverage

Five Jest tests (`jest/stripe/connector.test.js`), each running a sequence of internal steps (see `tests/stripe/*.js`). All 5 run concurrently via `test.concurrent()` — see the README's "Why the 5 tests run concurrently, safely" section for why that's safe.

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

## C: Data Correctness

Checks the seeded Stripe sandbox data (see the bulk seed script) against expected values.

| Step | What it does | Expected result |
|---|---|---|
| Customer count | `SELECT COUNT(*) FROM customers` | ≈ `NUM_CUSTOMERS` (±10%) |
| Charge distribution | Count refunded vs total charges | ≈15% refunded (±generous tolerance) |
| Subscription distribution | Count active/canceled subscriptions | Some active or canceled present |
| Invoice count | `SELECT COUNT(*) FROM invoices` | ≈25% of customer count |
| Spot check | Query a specific known seeded customer | Name/email match what was seeded |

## D: Cache Behavior

Another real internal dependency chain — status-checking and duplicate-checking need the cache from the first step to exist.

| Step | What it does | Expected result |
|---|---|---|
| Select cache-target table | Live `listTables` call, picks a cacheable table that Data Correctness (C) never queries - avoids a confirmed real interference bug where concurrent cache creation on a table C is querying returns 0 rows (see Known Gaps in README) | A cacheable table found, excluding `customers`/`charges`/`subscriptions`/`invoices` |
| Create cache | POST cache on the selected table, no schedule | 200, cache ID returned |
| Poll status | Poll cache status until terminal | Reaches a `SUCCESS`/`COMPLETED`-type status |
| Non-cacheable rejection | Find a non-cacheable table (reuses the table list from the selection step), attempt cache creation on it | 400, `errorCode: TABLE_NOT_CACHEABLE` |
| Duplicate creation handled cleanly | Attempt cache creation again on the same selected table | 200 or 409 - Peaka's real behavior is a get-or-create (200), not the documented 409; see Known Gaps in README |

## F: Error Handling & Edge Cases

| Step | What it does | Expected result |
|---|---|---|
| Non-existent table | Query a table that doesn't exist | Clean 4xx, not a crash |
| Pagination | Query `charges` with `limit/offset` across two pages | No overlapping/missing rows between pages |

## Extending

Add a new step to the relevant category's `run*()` function in `tests/*.js`, wrapped in `step("description", async () => {...})` from `helpers/step.js` — this tags any thrown error with which step produced it, so a failure in a multi-step test still tells you exactly what broke.

If a genuinely new, independent category is needed (not fitting A/B/C/D/F), add a new `tests/stripe/<letter>-<name>.js` file exporting a `run<Name>(ctx)` function, then add a `test.concurrent(...)` block for it in `jest/stripe/connector.test.js` — following the same pattern (fresh `ctx`, `requireCredentials()`, add to the `afterAll` cleanup list).
