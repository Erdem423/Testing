# Peaka × HubSpot Connector — Test Coverage

Eleven scenarios, mirroring `STRIPE_TEST_SCENARIOS.md`'s structure exactly. `B`/`C`/`F` share
`jest/hubspot/connector.test.js` and run concurrently via `test.concurrent()`; `G`-`N` each have their
own `jest/hubspot/<name>.test.js` so Jest runs them in separate worker processes. All step logic lives
in `tests/hubspot/*.js`.

**Confirmed live and passing (2026-08-12) against a real HubSpot Developer Test Account and the
pre-existing `hubspot` catalog in Peaka Studio.** Real measured data: `contacts` 650 rows, `companies`
675 rows, `deals` 101 rows.

## How this differs from the Stripe suite

- **Credential shape is OAuth2, not a secret key.** Confirmed via `getConnectionConfig("hubspot")`:
  fields are `accessToken`/`refreshToken`/`clientId`/`clientSecret`/`redirectUrl`, not Stripe's
  `sk_test_.../rk_test_...`. A HubSpot **Service Key** (the current-generation replacement for what
  HubSpot used to call Private Apps / now calls Legacy Apps) works as `HUBSPOT_ACCESS_TOKEN` — confirmed
  by actually running `G` against one.
- **`HUBSPOT_ACCESS_TOKEN` is required for every scenario**, even `B`/`C`/`F`/`I`/`J`/`K` which never
  read it — `checkCredentials()` checks it unconditionally for this connector, same blanket-requirement
  design Stripe's suite already had. Without it, all eleven report as **skipped**, not failed.
- **No live-query row cap, unlike Stripe.** Stripe's confirmed 100-row cap on uncached reads (see the
  README's "What it found") does **not** reproduce on HubSpot — live and cached counts matched exactly
  on every table (`contacts` 650=650, `companies` 675=675, `deals` 101=101), including a 500-row
  `SELECT ... LIMIT 500` returning all 500 uncached. `C`'s HubSpot version deliberately does not assert
  a cap because of this — see its header comment for the full reasoning.
- **Some findings carry over identically.** `getTableStatistics` is unsupported for hubspot catalogs
  too (`400 "Catalog type: hubspot is not being supported yet"`), and the schema-level cache-status
  endpoint also returns `500` — both confirmed live, not assumed.
- **A new finding, not present in the Stripe suite:** several HubSpot tables' cache jobs never reach
  `COMPLETED` — `owners`, `pipelines`, `products`, `feedback_submissions` all sat at `RUNNING`
  indistinguishably from healthy after 60s+ in a direct measurement. Same failure class as FINDINGS.md
  #5 (Stripe's `terminal_configurations`), now confirmed on a second connector.

## B: Catalog & Schema Discovery

| Step | What it does | Expected result |
|---|---|---|
| Read pre-existing catalog | GET catalog using `PEAKA_HUBSPOT_CATALOG_ID` | 200, `catalogType: hubspot`, includes queryable `name` |
| List schemas | GET schemas for the catalog | Includes `crm` (`PEAKA_HUBSPOT_SCHEMA_NAME`). HubSpot also exposes `conversations`, `crm_associations`, `scheduler`, `settings` — out of scope for this suite |
| List tables | GET tables for the `crm` schema | Includes at minimum `contacts`, `companies`. `*_search` entries (e.g. `contacts_search`) are function-style, not plain tables, and deliberately excluded from this check |
| Verify cache flags | Inspect `isCacheable`/`supportedCacheTypes` on `contacts` | `isCacheable: true`, supports at least one cache type |
| List columns (×3) | GET columns for `contacts`, `companies`, `deals` | Each includes `id` (the only field asserted so far — logs the full real column list so `EXPECTED_COLUMNS` can be widened; real columns include e.g. `hs_object_id`, `dealstage`, `hubspot_owner_id`) |

## C: Data Correctness & Cache Behavior

Runs every check twice — once uncached, once cached — with the cache lifecycle in between, same shape
as Stripe's `C`. Unlike Stripe's version, **does not assume a live-query cap exists** (see above) —
instead it measures and logs, only asserting the connector-agnostic invariant that cached counts can
never be *lower* than live ones.

### Phase 1 — uncached

| Step | What it does | Expected result |
|---|---|---|
| Resolve catalog name | `getCatalog`, falling back to `PEAKA_HUBSPOT_CATALOG_NAME` | A queryable catalog slug |
| Tables all start uncached | `isCached` on `contacts`/`companies`/`deals` | All `false`; same corruption detector and self-heal logic as Stripe's `C` if a leftover cache is found |
| Live counts measured | `COUNT(*)` on all three | Non-negative numbers, logged for comparison against Phase 3 (measured: 650/675/101 — matches cached exactly) |
| Live SELECT logged | `SELECT id FROM contacts LIMIT 500` | Logged, duplicate-free (measured: 500/500 rows — no truncation) |
| Live spot check | First `contacts` row has a populated `id` | Generic sanity check — no specific seeded-record assertion, since seed-data naming conventions aren't known for this account |

### Phase 2 — cache lifecycle

| Step | What it does | Expected result |
|---|---|---|
| Create caches | `createCache` on `contacts`/`companies`/`deals` | 200 (or 409), cache id returned for each |
| Poll to completion | All three polled in parallel | All reach `COMPLETED` |
| Verify cached | `isCached` on all three | All now `true` |

### Phase 3 — cached

| Step | What it does | Expected result |
|---|---|---|
| Cached counts vs live | Same `COUNT(*)` queries | Never lower than the live count; logs a note if cached > live (would be the same signature as Stripe's cap bug — not observed here) |
| Cached SELECT vs live | `SELECT id FROM contacts LIMIT 500`, cached | Duplicate-free, logged against the live figure |
| Live vs cached summary | Logs every metric side by side | Informational |

### Phase 4 — cache edge cases

| Step | What it does | Expected result |
|---|---|---|
| Non-cacheable rejection | `createCache` on a table with `isCacheable: false` | 400, `errorCode: TABLE_NOT_CACHEABLE` (skips cleanly if every table in the catalog happens to be cacheable) |
| Duplicate creation | `createCache` again on `contacts` | 200 or 409 — not assumed which, just that it isn't a 500 (the settled cache from Phase 2 rules out the genuine mid-sync race) |

## F: Error Handling & Edge Cases

| Step | What it does | Expected result |
|---|---|---|
| Non-existent table | Query a table that doesn't exist | Clean 4xx, not a crash |
| Pagination | Query `line_items` with `limit/offset` across two pages | No overlapping rows between pages. Deliberately not `contacts`/`companies`/`deals` — `C` caches those concurrently, and querying a table mid-sync is a known Peaka risk. (In this account, `line_items` had no seed data, so the step logs a skip rather than asserting on an empty page — not a failure) |

## G-N: Base API endpoint coverage

Each creates whatever resources it needs and deletes them again. Content mirrors the Stripe versions
almost exactly (these endpoint groups are largely connector-agnostic Peaka behavior) — differences are
called out below.

| Scenario | Endpoints | Notes |
|---|---|---|
| **G: Connection Endpoints** | create, list, get, update, delete, list/get connector config | The only scenario that genuinely requires `HUBSPOT_ACCESS_TOKEN` for a structural reason (connection CRUD is literally what it tests). `getConnectionConfig("hubspot")` confirms `authorizationType: oauth2` live. Credential-masking check scans for the raw token but not for connector-specific prefixes (HubSpot's OAuth2 token has no fixed prefix like Stripe's `sk_`/`rk_`) |
| **H: Catalog Endpoints** | catalog create/list/delete, project search, table statistics | Creates its own connection (tried reusing the existing one to avoid needing a token — Peaka rejected it with a `500`, see `tests/hubspot/h-catalogs.js`'s header comment). `getTableStatistics` confirmed `400 "Catalog type: hubspot is not being supported yet"` — same limitation as Stripe |
| **I: Saved Query Endpoints** | query create/list/read/update/delete, SQL transpile | Needs no connection — doesn't require the token. Content identical to Stripe's version aside from querying `contacts` instead of `customers` |
| **J: Internal Table Endpoints** | table create/list/delete, column add/list/delete | Project-level, connector-agnostic — near-identical copy of the Stripe version |
| **K: Export Endpoints** | export create/read/list/cancel | Exports from a saved query, not directly from HubSpot data — connector-agnostic, near-identical copy of the Stripe version |
| **L: Metadata Refresh Endpoints** | refresh, refresh status | Runs against its own catalog+connection, same reasoning as Stripe's `L` (refreshing the shared catalog would disturb `B`/`C`) |
| **M: Cache Management Endpoints** | settings get/update, batch create, all-statuses ×3, execution history, trigger/cancel incremental + full refresh, delete | Fixture tables (`FIXTURE_TABLE = "tasks"`, `BATCH_TABLE = "deals_pipeline_stages"`) are **measured**, not guessed: `deals_pipeline_stages` ~4.5s, `deals` ~4.4s, `tasks` ~5.1s all reach `COMPLETED`; `owners`, `pipelines`, `products`, `feedback_submissions` never did (still `RUNNING` after 60s+) — a real, newly-confirmed finding. `FIXTURE_TABLE` specifically needs `INCREMENTAL` support (this scenario triggers both incremental and full refresh), which `deals_pipeline_stages` lacks (`FULL_REFRESH` only) — that's why `tasks` was picked over the marginally faster option. Malformed-schedule and schema-level-500 findings both confirmed identical to Stripe |
| **N: Materialized Query Endpoints** | create (via `queryType: MATERIALIZED`), read status, list statuses, refresh, cancel | Runs against its own catalog+connection, materializing `contacts`. Same `CANCELED`/`CANCELLED` spelling inconsistency as Stripe applies here too (it's a Peaka-wide quirk, not connector-specific) |

## Extending

Add a new step to the relevant category's `run*()` function in `tests/hubspot/*.js`, wrapped in
`step("description", async () => {...})` from `helpers/step.js`. **Update `tests/hubspot/meta.js`'s
step list in the same change** — it drives the dashboard and has already drifted stale once during
development.

**Before asserting a specific value for anything not yet measured against this account** (row counts,
cache sync times, exact error codes), check the comments in the relevant file first — several
assertions here were deliberately left loose (`assertStatusIn` over multiple plausible outcomes, or a
`console.log` instead of an assertion) specifically because they had not been observed against real
HubSpot data when written. Tighten them once you've confirmed the real behavior, following the same
"measure, then assert" discipline this file's own fixture-table choice for `M` was corrected with.

## Related documents

| Document | Contents |
|---|---|
| [STRIPE_TEST_SCENARIOS.md](STRIPE_TEST_SCENARIOS.md) | The equivalent breakdown for the Stripe connector |
| [FINDINGS.md](FINDINGS.md) | Peaka bugs found via the Stripe suite — several (table statistics, schema-level cache status, hanging cache jobs) are now confirmed to reproduce on HubSpot too |
| [README.md](README.md) | Setup, `.env` variables for both connectors, and the "What it found" section covering the credential-shape and no-cap findings above |
