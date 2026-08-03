# Coverage map — current suite vs. the STRIPE-01…21 scenario spec

Maps what this repo actually tests today against the 21-scenario E2E spec. Written by reading the
test sources directly (`tests/stripe/*.js`), not from the docs, since those have drifted before.

**Current suite:** 12 scenarios / 109 steps. `B` (8), `C` (21), `F` (5) share one file as
`test.concurrent()` blocks; `G` (9), `H` (6), `I` (8), `J` (6), `K` (6), `L` (5), `M` (17), `N` (9),
`O` (9) each have their own file and run in separate Jest workers.

`O: Data Freshness` is the newest and the only scenario that **writes to Stripe** — it adds a customer,
proves a refresh makes it visible, then deletes it again.

`A: Connection Setup` was merged into `G` on 2026-07-31 — both covered connections, and A's create step
asserted a strict subset of G's. Only its invalid-token check was unique, which is why `G` is now 9.

## Scoreboard

| Status | Count | Scenarios |
|---|---|---|
| ✅ Covered | 12 | 01, 08, 09, 13, 14, 15, 16, 17, 18, 19, 20, 21 |
| 🟡 Mostly (one assertion short) | 1 | 02 |
| 🟠 Partial | 5 | 03, 05, 06, 07, 10 |
| ❌ Missing | 3 | 04, 11, 12 |

**Previously 11 were missing; now 3.** Scenarios `G`–`N` were added to cover the base API endpoints, with
scope taken from Peaka's own reference rather than the instructor's summary table — so they also cover
endpoints that table omits (cache settings, batch creation, the three all-statuses variants, execution
history, connector config, search, SQL transpile).

What remains missing: **04** (empty-credential validation, nobody has built it), **11** (aggregate cross-checks —
notably a second, independent way to catch the 100-row cap), and **12** (cross-catalog joins, blocked on the
internal-table `INSERT` shape).

---

## Scenario-by-scenario

### Section A — Connection Lifecycle

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 01 | Valid key → create, list, get | ✅ Covered | `G` steps 1–4, 8 | Create, list, get all asserted. **Credential masking is now tested** — `G` scans the whole serialized `getConnection` body for the raw token and for `sk_`/`rk_` prefixes |
| 02 | Delete + access deleted | 🟡 Mostly | `G` step 8 | Deletion is asserted, and the connection is confirmed gone from both `getConnection` and `listConnections`. Not covered: querying *through* a catalog whose connection was deleted. **Note:** Peaka returns `400`, not the `404` this spec expects — see the comment in `g-connections.js` |
| 03 | Invalid API key | 🟠 Partial | `G` step 2 sends `"not_a_real_token"` (was `A`, merged into `G` 2026-07-31) | Accepts `[200, 400, 401, 422]` and, on 200, only `console.log`s "verify downstream." The spec requires **following through** to catalog + table-list and asserting the failure actually surfaces somewhere. As written this step can pass while the bad token is silently accepted |
| 04 | Empty / missing credential | ❌ Missing | — | No test for `credential: {}` or `token: ""` |
| 05 | Credential update (break → fix) | 🟠 Partial | `G` step 5 updates the connection's **name**; Tier 2.7 attempts the credential swap | Peaka **rejects** an obviously-fake token at update time with `400`, which is good behaviour but means the interesting question stays unanswered: if a swap succeeds, do queries start failing? Probing that needs a token that is well-formed and accepted at update time but unauthorised at query time — a revoked key, not a fake one |

### Section B — Metadata / Discovery

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 06 | Table list + cache-eligibility fields | 🟠 Partial | `B` steps 3–4 | Core-table check covers only `customers` + `charges`; spec wants all four (`invoices`, `subscriptions` too). `supportedCacheTypes` is verified **only on `customers`**, not on every `isCacheable: true` table |
| 07 | Column metadata (`charges`) | 🟠 Partial | `B` steps 5–8 check column **names** on 4 tables | **No type assertions** — spec wants `amount` numeric, `created` timestamp. Also `created` isn't in `EXPECTED_COLUMNS.charges` at all. Type checking is the part that catches Stripe API version drift, which is the stated purpose |
| 08 | Metadata refresh flow | ✅ Covered | `L` — trigger, poll to terminal, confirm the catalog still lists schemas | Runs against a catalog `L` creates itself, so it can't disturb `B`/`C` reading the shared one |

### Section C — Query Execution

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 09 | Simple SELECT | ✅ Covered | `C` — a dedicated shape step, plus the existing `SELECT` steps | Asserts returned column **names and order** match the request, ids match `/^ch_/`, rows carry exactly the requested keys, and `amount` comes back as a **string** — a quirk pinned deliberately so a fix goes red and gets noticed |
| 10 | WHERE filters | 🟠 Partial | `C` uses `WHERE refunded = true`, `WHERE status = 'active'/'canceled'` | Only ever as `COUNT(*)`. **No test fetches rows and verifies each one satisfies its filter** — a filter could be silently ignored and the counts would still look plausible |
| 11 | Aggregates vs. computed-from-raw | ❌ Missing | — | Nothing cross-checks a `SUM`/`COUNT` against totals computed client-side from raw rows. Notable: **this is a second, independent way to catch the `COUNT(*)` cap** |
| 12 | Cross-catalog join (federation) | ❌ Missing | — | The internal-table methods now exist and `J` exercises them, but **`INSERT` into an internal table is still unsolved**, so there is no way to put rows on the other side of a join |
| 13 | Saved query lifecycle | ✅ Covered | `I` — CRUD, execute by **id**, execute by qualified **name**, SQL transpile | Probing settled the shape the reference omits: the saved-query branch keys off **`id`**, not `queryId` (which the instructor's spec guesses, and which returns 400). Execute-by-name has no working dedicated field — reached via the statement branch instead |
| 14 | Materialized query | ✅ Covered | `N` — create, status, list statuses, refresh, cancel, recovery, `inputQueryRefId` variant, delete | `inputQueryRefId` turned out to be **optional** — `inputQuery` alone materializes fine |
| 15 | Bad identifiers | ✅ Covered | `F` — non-existent table, schema and column | Schema and column assert an exact `400` **and** that the error names the offending identifier. The message check is what separates a genuine resolution failure from a parse error or timeout that happens to `400` |

### Section D — Cache

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 16 | Cache lifecycle | ✅ Covered | `C` steps 7–9 create/poll/verify; `M` closes the loop by deleting and asserting `isCached` flips back to **false** | — |
| 17 | Non-cacheable table rejection | ✅ Covered | `C` step 17 — asserts `400` + `errorCode: TABLE_NOT_CACHEABLE` | — |
| 18 | Incremental refresh + data freshness | ✅ Covered | `M` for the endpoints; `O` for freshness | `O` creates a real Stripe customer, proves it is **not** visible before a refresh, then that it is after — **measured: incremental sync does detect inserts.** It also checks the reverse, that an upstream delete is reflected, and that the count moves by exactly one so a duplicating refresh is caught |

### Section E — Resilience & Export

| # | Scenario | Status | Where | Gap |
|---|---|---|---|---|
| 19 | Parallel query / rate-limit resilience | ✅ Covered | Tier 3.10 (`npm run test:races`) | 20 simultaneous queries, all `200`. No `429`, no `5xx`, nothing hung — so this passes trivially rather than revealing anything, which is worth knowing before treating it as a meaningful test |
| 20 | Pagination beyond Stripe's page size | ✅ Covered | `C` asserts `LIMIT 500` returns exactly 100 live and **>100 cached** (measured: 500), both duplicate-free; `F` step 3 covers non-overlapping offset windows | The live half can only ever return 100 — that's the documented cap, asserted deliberately. The cached half is the only context where a >100-row result is obtainable at all |
| 21 | CSV export | ✅ Covered | `K` — start, poll to `SUCCEEDED`, assert `rowCount` and a downloadable file URL, list, cancel (twice, for idempotency) | — |

---

## Client method coverage

`helpers/peakaClient.js` now covers the data-plane surface: connections (create/list/get/update/delete +
config), catalogs (create/read/list/delete/search/statistics), schemas/tables/columns, `isTableCached`,
cache (create/batch/settings/status/history/all-statuses ×3/trigger ×2/cancel ×2/delete), queries
(CRUD + execute), exports (create/read/list/cancel), metadata (refresh + status), Peaka internal tables
(table and column CRUD), and SQL transpile.

Materialized queries and execute-by-saved-query-id were unblocked by probing the live API rather than the
reference, which only names those request branches without expanding their fields:
- **execute by saved query** keys off **`id`** — not `queryId` (which the instructor's spec guesses, and
  which returns 400), nor `queryRefId`/`savedQueryId`, nor the id passed as a JSON number.
- **`queryType: "MATERIALIZED"`** works with `inputQuery` alone; `inputQueryRefId` is optional and, when
  given, copies the referenced query's SQL in.

Still absent: **`INSERT` into an internal table** (blocks scenario 12), the query-builder's **`filters`**
field (four shapes probed, all 400), and a dedicated **execute-by-name** branch — saved queries are reachable
by qualified name through the statement branch instead, which is what `I` asserts.

Endpoints deliberately not implemented because their paths weren't verified: `Export Table (async)`,
`Update Column` (internal tables), `Update Query Path`, `Get Connection Detail`. Guessing a path is how
three cache endpoints stayed wrong for months.

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
