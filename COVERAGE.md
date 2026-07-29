# Coverage map — current suite vs. the STRIPE-01…21 scenario spec

Maps what this repo actually tests today against the 21-scenario E2E spec. Written by reading the
test sources directly (`tests/stripe/*.js`), not from the docs, since those have drifted before.

**Current suite:** 4 concurrent tests / 31 steps total — `A` (2 steps), `B` (8), `C` (18), `F` (3).

## Scoreboard

| Status | Count | Scenarios |
|---|---|---|
| ✅ Covered | 1 | 17 |
| 🟡 Mostly (one assertion short) | 1 | 16 |
| 🟠 Partial | 8 | 01, 03, 06, 07, 09, 10, 15, 20 |
| ❌ Missing | 11 | 02, 04, 05, 08, 11, 12, 13, 14, 18, 19, 21 |

The shape of the gap: **caching and data correctness are deep; everything else is thin or absent.**
`C` alone accounts for 18 of 31 steps. Connection lifecycle is 2 steps, and the entire
query/materialized-query/export surface is untested.

---

## Scenario-by-scenario

### Section A — Connection Lifecycle

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 01 | Valid key → create, list, get | 🟠 Partial | `A` step 1 creates a connection and asserts `id` + `type` | No **ConnList**, no **ConnGet** (neither method exists on `PeakaClient`). **Credential masking is untested** — nothing verifies the Stripe key isn't echoed back in plaintext |
| 02 | Delete + access deleted | ❌ Missing | `helpers/cleanup.js` deletes connections | Deletion happens but is never *asserted*: no 404-on-get check, no "queries through the dead catalog fail meaningfully" check |
| 03 | Invalid API key | 🟠 Partial | `A` step 2 sends `"not_a_real_token"` | Accepts `[200, 400, 401, 422]` and, on 200, only `console.log`s "verify downstream." The spec requires **following through** to catalog + table-list and asserting the failure actually surfaces somewhere. As written this step can pass while the bad token is silently accepted |
| 04 | Empty / missing credential | ❌ Missing | — | No test for `credential: {}` or `token: ""` |
| 05 | Credential update (break → fix) | ❌ Missing | — | `updateConnection` doesn't exist on the client. This is the credential-caching bug class — arguably the most interesting untested behavior in this section |

### Section B — Metadata / Discovery

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 06 | Table list + cache-eligibility fields | 🟠 Partial | `B` steps 3–4 | Core-table check covers only `customers` + `charges`; spec wants all four (`invoices`, `subscriptions` too). `supportedCacheTypes` is verified **only on `customers`**, not on every `isCacheable: true` table |
| 07 | Column metadata (`charges`) | 🟠 Partial | `B` steps 5–8 check column **names** on 4 tables | **No type assertions** — spec wants `amount` numeric, `created` timestamp. Also `created` isn't in `EXPECTED_COLUMNS.charges` at all. Type checking is the part that catches Stripe API version drift, which is the stated purpose |
| 08 | Metadata refresh flow | ❌ Missing | — | No client method, no test |

### Section C — Query Execution

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 09 | Simple SELECT | 🟠 Partial | `C` step 6 (`SELECT name, email … LIMIT 1`), `F` step 3 (`SELECT id`) | No test asserting returned column names match the requested set, or that `id` values start with `ch_`. Value-shape validation is absent |
| 10 | WHERE filters | 🟠 Partial | `C` uses `WHERE refunded = true`, `WHERE status = 'active'/'canceled'` | Only ever as `COUNT(*)`. **No test fetches rows and verifies each one satisfies its filter** — a filter could be silently ignored and the counts would still look plausible |
| 11 | Aggregates vs. computed-from-raw | ❌ Missing | — | Nothing cross-checks a `SUM`/`COUNT` against totals computed client-side from raw rows. Notable: **this is a second, independent way to catch the `COUNT(*)` cap** |
| 12 | Cross-catalog join (federation) | ❌ Missing | — | No internal-table methods (`PeakaTableCreate`/`Columns`/`Delete`), no join test |
| 13 | Saved query lifecycle | ❌ Missing | — | No query CRUD methods at all |
| 14 | Materialized query | ❌ Missing | — | No methods, no test |
| 15 | Bad identifiers | 🟠 Partial | `F` step 2 covers a non-existent **table** | Missing bad **schema** and bad **column** variants (1 of 3) |

### Section D — Cache

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 16 | Cache lifecycle | 🟡 Mostly | `C` steps 7–9 (create → poll → `isCached: true`), steps 10–15 query through cache | Missing the final leg: after `deleteCache`, assert `isCached` flips back to **false** and the query still works (now live). Deletion happens in `afterAll` but is never asserted |
| 17 | Non-cacheable table rejection | ✅ Covered | `C` step 17 — asserts `400` + `errorCode: TABLE_NOT_CACHEABLE` | — |
| 18 | Incremental refresh + data freshness | ❌ Missing | `triggerIncrementalUpdate` exists (path corrected in PR #3) but **nothing calls it** | Requires writing to the Stripe test account. This is the only genuine end-to-end data-flow test in the spec |

### Section E — Resilience & Export

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 19 | Parallel query / rate-limit resilience | ❌ Missing | — | No concurrency-stress test |
| 20 | Pagination beyond Stripe's page size | 🟠 Partial | `F` step 3 — `limit 20 / offset 20`, asserts no overlap | **Never crosses the 100-row boundary**, which is exactly where the cap lives. Spec wants `LIMIT 500`, >100 rows returned, no duplicates. As written it can't detect the pagination bug this project already documented |
| 21 | CSV export | ❌ Missing | — | No export methods, no test |

---

## Missing client methods

`helpers/peakaClient.js` has no equivalent for roughly half the spec's endpoint table:

- **Connections:** `listConnections`, `getConnection`, `updateConnection`
- **Queries:** create / list / get / update / delete
- **Materialized queries:** status, refresh
- **Exports:** create, get
- **Metadata:** refresh, refresh-status
- **Peaka internal tables:** create, add columns, delete

Present and correct: connections (create/delete), catalogs (create/read/delete), schemas/tables/columns,
`isTableCached`, cache (create/status/delete/incremental/full-refresh/cancel), `executeQuery`.

---

## Convention gaps (independent of scenario coverage)

These apply across the whole suite and are cheap relative to their value:

1. **Non-deterministic resource names.** `A` creates `test-stripe-conn-${Date.now()}`. The spec mandates
   fixed `e2e-auto-` names precisely so a crashed run's leftovers can be found by name and swept at the
   *start* of the next run. Today cleanup is `afterAll`-only, so `SKIP_CLEANUP=true` or a crash leaves
   state behind — which already forced a workaround in `C` (detect an existing cache on `customers`
   and skip the live phase). Start-of-run cleanup would remove the need for that workaround entirely.

2. **No scenario IDs.** Failures read as a 60-character prose step name inside an 18-step test rather
   than `STRIPE-03`. Matters most for the web dashboard, where someone else reads the result.

3. **No "5xx is always a failure" invariant.** Applied ad hoc (`C` step 18 rejects `500` on duplicate
   cache creation) rather than globally.

4. **Missing config throws instead of skipping.** `requireCredentials()` fails the test; the spec wants
   a *skip* with a stated reason, so a partially-configured environment still reports usefully.

5. **Individual scenarios aren't independently runnable.** The dashboard can filter to a whole test, but
   there's no way to run just "the duplicate-cache check." This is the direct trade-off of consolidation —
   the spec buys per-scenario independence by having each scenario build its own connection + catalog.

6. **The suite depends on a hand-provisioned catalog** (`PEAKA_CATALOG_ID` in `.env`). Every spec
   scenario builds its own, so the spec's suite would run against a fresh project; this one would not.

---

## Where this suite goes beyond the spec

Worth stating, since a coverage map otherwise reads as pure deficit:

- **Live-vs-cached comparison as a first-class subject.** `C` runs every assertion twice and diffs them.
  The spec checks `isCached` but never systematically compares results across the boundary.
- **Three documented product findings** with reproductions: the `COUNT(*)` cap (all four tables, plus the
  narrower discovery that filtered counts are capped too, so the truncation is on the scan not the
  aggregate), the duplicate-cache `200`/`409` docs divergence, and cache jobs that hang forever with no
  error surface.
- **A caveat on spec rule 8** ("assert on row existence, not row counts"): followed literally, that
  convention would have hidden the `COUNT(*)` cap. The spec does catch it elsewhere — via 11 and 20 —
  but the count-based assertions here are what actually found it.

---

## Suggested order, by value per unit of work

1. **Cheap, high value, no new client surface:** 15 (add 2 identifier variants), 20 (raise the limit past
   100), 06 + 07 (broaden table/column assertions, add type checks), 16 (assert `isCached: false` after delete).
2. **Small client additions, closes the biggest hole:** 01 credential masking, 02, 04, 05 — connection
   lifecycle is currently 2 steps and includes a genuine security check that doesn't exist.
3. **Structural, do once:** deterministic `e2e-auto-` naming + start-of-run cleanup; scenario IDs.
4. **New surface area, larger builds:** 13 → 14 → 21 (queries → materialized → export), then 11, 12, 08.
5. **Needs care with shared accounts:** 18 (writes to Stripe), 19 (rate-limit stress could affect other
   concurrently-running tests).
