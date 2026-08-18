# Findings — Peaka Partner API & Stripe connector

Everything below was observed against a live Peaka project and a seeded Stripe sandbox, not inferred
from documentation. Each entry states how it was measured so it can be re-checked or reported upstream.

## Which findings are Peaka's, and which are the Stripe connector's

Every finding here was originally measured against Stripe alone, so none of them could distinguish
*"Peaka does this"* from *"Peaka's Stripe connector does this"*. A second connector settles it, which is
why `tests/postgres/` exists. Measured 2026-08-04 against a 25,000-row Postgres table:

| Behaviour | Stripe | Postgres | Verdict |
|---|---|---|---|
| 100-row read cap | `COUNT(*)` = 100 of 652 | **25000 of 25000**; `LIMIT 500` returns 500 | **Connector-specific** |
| `WHERE` filters only the first 100 rows | yes | **no** — 2528 matches across the whole table | **Connector-specific** |
| Table export cap | file holds 100 of 652 rows | **1000 of 1000 requested** | **Connector-specific** |
| Materialized query cap | snapshot frozen at 100 of 505 rows | **25000 of 25000, in full** | **Connector-specific** |
| Saved query, executed by name | returns the cap | **the whole table** | **Connector-specific** |
| Table statistics endpoint | `400` "not being supported yet" | **`200`, real per-column stats** | **Connector-specific** |
| Values arrive as strings regardless of declared type | yes | **yes** — `bigint` → `"25001"`, `double` → `"669.74"` | **Platform-wide** |
| Caching available at all | yes | **no** — 0 of 40 tables, enforced | **Connector-class** |

**The cap is a symptom of API pagination**, not a Peaka-wide defect: 100 is Stripe's List API page size,
and Peaka does not walk the remaining pages. A database has no pages, so no cap — and the same fact
explains why caching exists for Stripe and not for Postgres. **They are the same fact.** Caching exists to
escape slow paginated APIs; Trino queries Postgres directly, so there is nothing to escape.

That is a sharper claim than "the Stripe connector truncates reads", and it is now proven through **four
independent subsystems** rather than one — `PG-B` (raw queries), `PG-C` (exports), `PG-D`
(materialization) and `PG-H` (saved queries) all ask the same question of a different Peaka code path and
get the same answer. Each is asserted, not just observed: every one of the four fails if its subsystem
ever starts truncating a database connector's reads, and `PG-A`/`PG-G` fail if databases ever become
cacheable or gain Stripe's statistics limitation.

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Live (uncached) queries silently return at most **100 rows** — any query, not just `COUNT(*)` | **High** | Open, asserted as a regression test |
| 2 | **A materialized query over an uncached table permanently captures only 100 rows** | **High** | Open, newly found |
| 3 | Deleting a cache can leave a table **permanently unreachable** through Peaka | **High** | Repaired by rebuilding the catalog; detector added |
| 4 | Duplicate `createCache` during an in-progress sync returns **`500`**, not the documented `409` | Medium | Open, reproduced deliberately in Tier 1 |
| 5 | `cancelFullRefresh` **`500`s on a null execution record** (missing null check) | Medium | Open, no longer provoked by the suite |
| 6 | Some cacheable tables produce cache jobs that **hang forever, indistinguishably from healthy** | Medium | Open, documented not asserted |
| 7 | Schema-level cache-status endpoint returns **`500`** | Low | Open, asserted as known behaviour |
| — | **The 100-row cap reaches export files** — a CSV reports success holding 100 of 652 rows | **High** | Open, asserted in `K` |
| — | **Exporting an empty table FAILS** rather than producing an empty file | Low | Open, observed |
| — | An export started mid-sync failed while its control succeeded — *suggestive only*, exports also fail intermittently without a race | Low | Open, needs repeating |
| — | **A materialized query built mid-sync captures ZERO rows, permanently** (Tier 4) | **High** | Open, reported not asserted |
| — | Incremental sync **removes deleted rows but reports `numberOfDeletedRecords: 0`** (see *Incremental really is incremental*) | Low | Open, reported not asserted |
| 9 | **`SqlExec` cannot write at all** — INSERT/UPDATE/DELETE/CTAS all `400` | **High** | Open — the instructor's spec assumes DML through this endpoint; it does not exist |
| 10 | **CSV import silently accepts a mapping to a nonexistent column and writes `NULL`** | **High** | Open, asserted as a pinned deviation |
| 11 | **No row-level UPDATE/DELETE endpoint exists anywhere** for internal tables | **High** | Open, asserted as a capability gap |
| 12 | **BI Table's `displayName` is never respected**, at creation or update, across all 8 column types — the update endpoint's response actively lies about it | Medium | Open, asserted as a pinned deviation |
| 13 | **BI Table names collide after underscore-stripping** — two different requested names silently write to the same table | Medium | Open, asserted |
| 14 | JSON columns are rejected for **both** internal table kinds, contradicting the spec's own claim that Peaka Table supports them | Medium | Open |
| 15 | `getTableSample` is a **template generator and it conforms to the spec** — including the import round trip. Sole deviation: the header carries an undeclared `text` column. Required fixing a client bug (silent `null` body) to measure at all | Low | Conforms; asserted as a regression test |
| 16 | Trino requires `OFFSET` before `LIMIT`; the reverse order (valid Postgres/MySQL) is a syntax error | Low | Documented, worth knowing when porting SQL |
| 17 | Eleven smaller quirks that break naive clients, several contradicting the reference | Low | Open, documented |
| 18 | **Import validates VALUES strictly and atomically, but MAPPINGS not at all** — same endpoint, opposite rigor. The strict half is asserted so it cannot quietly relax | — | Verified working, pinned as a regression test |
| 19 | The 100-row cap does **not** apply to internal tables — a fifth confirmation it is Stripe-connector-specific | — | Verified working |
| 20 | **CSV import appends unconditionally and never deduplicates** — combined with 9 and 11, a Peaka Table can only ever *grow*; a mistaken row can never be corrected or removed | **High** | Open, asserted |
| 21 | Deleting a table is a genuine hard drop of data **and** declared schema, and ids are never reused | — | Verified working, pinned as a regression test |
| 22 | **`isUnique` and `isNotNull` are silently discarded at column creation** — sent `true`, stored `false`, with a `200` in between. `defaultValue` round-trips correctly | **High** | Open, asserted |
| 23 | A Peaka Table and BI Table sharing a name stay fully isolated, including on delete — and the spec's own version of this test never creates the collision | — | Verified working, pinned as a regression test |
| 24 | **The 100-row cap propagates through federated joins** — an aggregate over a join involving Stripe is computed on 100 of 505 rows and looks like a valid answer | **High** | Open, asserted |
| 25 | A saved query **silently re-binds** to a table recreated under the same name; dropping a column or the table breaks execution with a clean `4xx` but never the stored query | Medium | Open, asserted |
| 26 | An internal-table export is **uncapped** (7th confirmation) but carries all 8 system columns, so an exported file is not directly re-importable — unlike the sample endpoint's output | Low | Open, asserted |
| 27 | **A materialized query over an internal table holds no snapshot** — appended rows appear immediately, contradicting the docs' "slightly stale between refreshes". The exact inverse of finding 2 | Medium | Open, asserted |
| 28 | **A table comment breaks `createCache`** — the description is JSON-parsed, so a commented table gets a parser error with `errorCode: null` instead of its rejection. Returned as `400`, so the 5xx channel never sees it | Medium | Open, reported not asserted |
| 29 | **BI Table is writable in Studio but read-only through the Partner API** — the docs promise row-by-row inserts/updates/deletes and bulk insertion; the API offers none, while every read path works. Corrects the earlier "no write path at all" | **High** | Open, asserted |
| 30 | **`createCache` cannot refuse an internal table** — it dies looking up a mangled internal identifier with `errorCode: null`, for both table kinds. Second cause today of this endpoint eating its own error code | Medium | Open, asserted |
| 31 | Adding a column that already exists returns the **raw PostgreSQL exception** — internal schema name, generated SQL, PL/pgSQL function names and arguments | Low | Open, reported not asserted |
| 32 | MongoDB's `_id` is **absent from `listColumns` and `SELECT *` entirely**, and the obvious `WHERE _id = '<hex>'` filter is rejected on a type mismatch. A working but undocumented path exists (`CAST(_id AS VARCHAR)` / `objectid('<hex>')`) | Medium | Open, asserted |
| 33 | `getTableStatistics` is implemented for **Postgres only** — the two-connector pattern ("database connectors get it") breaks on a third; MongoDB gets Stripe's exact `400` | Low | Not a bug; corrects an over-generalization, asserted |
| 34 | Every Google Ads table carries **synthetic `_q_*` request-parameter columns** (pagination, limit, offset, query settings) mixed into its real data columns — always `NULL`, undistinguished by `listColumns` beyond the naming convention | Low | Not a bug, reported |
| 35 | The **Google Ads connector is measurably flaky** — the identical query intermittently returns correct data, a clean empty `200`, or an outright `400`, with no pattern found | Medium | Not a deterministic bug; retry-tolerant fixture built around it |
| 36 | Paginating a Google Ads table by a **low-cardinality column silently overlaps pages** — standard SQL tie-breaking behavior, not a Peaka bug, but an easy trap. `resource_name` columns are the safe, unique choice | Low | Not a bug; test design lesson, asserted with the fix |
| 37 | **Creating a Google Ads catalog needs OAuth secret/token even on an existing connection** — unlike Postgres/MongoDB, `{name, connectionId}` alone is rejected. Blocks connection-lifecycle and metadata-refresh scenarios | Medium | Access-scoping limitation, not a bug; scenarios scoped around it |
| 38 | **`createCatalog` 500s for every connection in some projects** - the project decides, not the connection; corrects the HubSpot attribution | Medium | Open - reported behaviour, wrong status code for what is likely a permission boundary |

Three endpoint paths in this repo's client were also wrong; see [Corrected endpoint paths](#corrected-endpoint-paths).

---

## 1. Live queries cannot return more than 100 rows

**The most serious finding here.** The Stripe connector silently returns partial result sets for
ordinary data-fetching queries — no error, no warning, no flag indicating the data is incomplete.
Anything built on a live query is reading truncated data and cannot tell. Caching bypasses it entirely.

Measured against `charges`, which has **652 real rows**, live and uncached (`isCached: false` verified
immediately beforehand):

| Query | Rows returned |
|---|---|
| `SELECT id … LIMIT 20` | 20 |
| `SELECT id … LIMIT 100` | 100 |
| `SELECT id … LIMIT 150` | **100** |
| `SELECT id … LIMIT 250` | **100** |
| `SELECT id … LIMIT 500` | **100** |

Identical through the query-builder request type, so it is not specific to raw SQL. `100` matches
Stripe's default List API page size — the likely cause is that Peaka does not paginate through
subsequent pages before returning.

**One mechanism, three symptoms.** The scan stops at 100 rows and everything downstream inherits it:

- `COUNT(*)` reports 100 because it counts a truncated scan.
- A `WHERE` clause filters *the first 100 rows only* — refunded charges gives `18` live vs `85` cached,
  i.e. 18 of the first 100. This was originally recorded as a separate filter bug; it is not one.
- Row-fetching queries return at most 100 rows regardless of `LIMIT`.

Counts across all four data tables, uncached then cached (same queries, caches created in between):

| Table | Live (uncached) | Cached | Real |
|---|---|---|---|
| `customers` | **100** | 505 | 505 |
| `charges` | **100** | 652 | 652 |
| `subscriptions` | **100** | 222 | 222 |
| `invoices` | **100** | 338 | 338 |

**How it is tested.** The live checks assert against `EXPECTED_CUSTOMER_COUNT_NON_CACHE` in `.env` (the
*known cap value*, default `100`) rather than real counts — a deliberate **passing** regression test
("is the cap still exactly 100?") instead of a check designed to fail forever. If Peaka fixes the
pagination these start failing; that is the intended signal. Do not "fix" them by raising the variable.
The cached pass separately asserts every table's count is *not* the cap, so truncation spreading to
cached reads surfaces immediately too. `C` also checks the row-retrieval form directly: a live
`SELECT id FROM charges LIMIT 500` returns exactly 100 rows on a 652-row table, and the same query
cached returns 500 — both duplicate-free.

**The cap is on the scan, and that is now measured rather than inferred.** This was previously argued from
filtered counts also being capped. Scenario 11 confirms it directly, by computing the total client-side
from the rows a caller can actually fetch and comparing against the server's aggregate:

| | `COUNT(*)` | `SUM(amount)` | Rows fetched | Client-side sum |
|---|---|---|---|---|
| Live | 100 | 633,201 | 100 | 633,201 |
| Cached | 652 | 4,183,762 | 652 | 4,183,762 |

Both sides agree in both phases, and **the agreement is the finding**: the aggregate is computed over
exactly the same truncated scan the rows come from. An aggregate evaluated over the full table would have
disagreed with the 100 rows a caller can retrieve — it does not.

**The cap follows the data into export files.** Measured 2026-08-04, and this is its third distinct
manifestation after `COUNT(*)` and row fetches:

| Export of `charges` (652 real rows) | Result |
|---|---|
| Via a saved query, uncached | `SUCCEEDED`, **`rowCount` 100** |
| Via `Export Table`, uncached | `SUCCEEDED`, **`rowCount` 100** |

A downloadable CSV reports success while holding under a sixth of the table. `K` now asserts this as a
passing regression test, the same way `C` asserts the live counts.

**One assertion had to be replaced because of this.** The old invoice check expected "~25% of customers"
and passed only because the cap clamped *both* sides to ~100. Against real data it is 338 invoices to
505 customers — 67%, nowhere near 25% — so it would have failed the moment it ran cached. Invoices are
generated by subscriptions rather than as a percentage of customers, so it now asserts the relationship
that actually holds: at least one invoice per subscription (338 to 222).

## 2. A materialized query permanently captures the 100-row cap

The 100-row cap is documented above as affecting *live reads* — transient, and fixable by caching the
table. This is the same bug made **durable**, and it was found while probing something else.

A materialized query is a **stored snapshot**, confirmed directly: adding a customer upstream and
re-reading via `executeQuery({ id })` did **not** show the new row until the query was refreshed. So
whatever it captures, it keeps.

Materialize `SELECT id, name FROM customers` against an **uncached** table of 505 rows, and the snapshot
holds **100** — the live cap, frozen. No race, no error, no warning. Every read of that materialized query
returns 100 rows forever, and nothing about it indicates the data is incomplete.

| | Rows |
|---|---|
| Real table | 505 |
| Live query (documented cap) | 100 |
| **Materialized snapshot over the uncached table** | **100, permanently** |

This is worse than the live cap in one specific way: a live query is at least *consistently* truncated and
obviously live. A materialized query is presented as a prepared dataset, is what a dashboard or downstream
job would be pointed at, and carries no signal that it holds a fifth of the data.

**Mitigation, and the reason this is worth reporting rather than just documenting:** cache the source table
*before* materializing. The cap only applies to live pass-through reads, so a materialized query built over
a cached table captures the full row set. Nothing in the API surfaces that ordering requirement.

`tests/races/tier4.js` covers the racier form of the same problem — a materialized query built while its
source is mid-sync, where the read returns 0 rather than 100.

**Report upstream as:** materialized queries silently inherit the live-query row cap, producing a permanent
snapshot of truncated data with no error or indication.

## 3. Deleting a cache can permanently break a table

Hit by ordinary use, not by the deliberate race tests. After many routine create/delete cycles (`C`
creates and deletes four caches every run), the shared catalog's `invoices` table entered a state it
could not leave:

| Probe | Result |
|---|---|
| `isTableCached(invoices)` | **`true`** |
| `getAllCacheStatusesOfProject` | **0 caches** |
| `getAllCacheStatusesOfCatalog` | **0 caches** |
| Live `SELECT` on `invoices` | **`400`** — `Table 'peaka.bitable.tableacc15ada…' does not exist` |
| `createCache(invoices)` | **`400`** — `Cannot create a table on a non-empty location: s3a://schemamapper…` |
| `createCacheBatch(invoices)` | `success: false`, same Iceberg error |

Peaka believed the table was cached, exposed no cache to delete, refused to re-cache it, and routed
queries to an Iceberg table that no longer existed. The damage was confined to that one table in that
one catalog — every other table queried fine, and `invoices` cached perfectly in a fresh catalog, so
Stripe and the connector were healthy.

**No API-side recovery exists.** Tried and failed: metadata refresh (no effect, and the refresh itself
never reached a terminal state in 80s), catalog- and project-level status listings (both empty),
`createCache`, `createCacheBatch`, and — checked last — the **internal-table namespace**. The failing
query names its backing table directly (`peaka.bitable.tableacc15ada3cf44509bc74ff8368667025`), and
`bitable` has its own CRUD endpoints, so `deleteInternalTable` looked like a possible handle. It is not
listed there either. The pointer and the `isCached` flag live somewhere no endpoint exposes.

**Repaired by rebuilding the catalog.** The `stripe` catalog was deleted and re-created on the same
connection with the same name; only `PEAKA_CATALOG_ID` changed. `invoices` came back `isCached: false`
and queryable. A fresh catalog gets fresh metadata, so the stale pointer is gone and the next cache on
that table is allocated a **new** internal table id — which is what sidesteps the still-dirty S3
location. Keeping the catalog *name* identical matters: the test SQL is three-part
(`"stripe"."payment"."invoices"`), so a rename would break every query.

**Not reproducible on demand.** Six deliberate attempts in a throwaway catalog all came back healthy:
delete mid-sync then re-create; six normal create/settle/delete cycles; delete before `RUNNING` appears;
provoking the mid-sync duplicate-create `500` then re-creating; `deleteCache` and `createCache` fired
concurrently; and two concurrent creates on a cold table. Two useful by-products: a create issued
*during* a delete returns `500` (non-destructive), and two concurrent creates on a cold table both
return `200`. The most likely trigger is a cache delete interrupted mid-sync — a dashboard server died
during a run earlier the same day, leaving four orphaned caches that were then deleted manually.

**So it is detected rather than reproduced.** `C`'s first step cross-checks `isTableCached` against the
catalog's cache listing. A table reporting `isCached: true` while **no cache is listed** is a
contradiction Peaka should never produce, and it is this corruption's exact signature. The check costs
one extra API call and fails in 3.6s with a diagnosis, where previously the problem surfaced ~48s later
as an opaque Iceberg error several steps removed from the cause. Verified both ways: it fires on the
real corrupted table, and stays quiet when a legitimate cache exists.

**Report upstream as:** cache deletion can leave a catalog's table pointing at a dropped Iceberg table,
breaking both reads and re-caching, with `isCached` still reporting `true` and no API handle to clear it.

## 4. Duplicate cache creation returns `500` mid-sync

Recorded for months as *inconsistent*: `500` once, `200` four times, with the `500` written off as a
one-off race. It is not inconsistent — it is **state-dependent**:

| Cache state when the duplicate `createCache` is attempted | Result |
|---|---|
| First sync still `RUNNING` | **`500 Internal Server Error`** |
| First sync `COMPLETED` | `200` — silent get-or-create |

Peaka's docs specify `409` for both. Reproduced deliberately by creating a cache on `customers`, polling
until `getCacheStatus` reported `RUNNING` (~2s), then firing a second `createCache` — `500` first
attempt. Every historical observation fits: the lone `500` was mid-sync, all four `200`s after
completion. Nobody had deliberately re-entered the failing window.

**Not destructive** — the original sync still reached `COMPLETED` and the cache deleted cleanly. A bad
response to a legitimate request rather than data loss.

Two neighbouring races came back **clean**: `deleteCache` mid-sync returns `200` and correctly flips
`isCached` to `false` with no orphan, and simultaneous `triggerIncrementalUpdate` +
`triggerFullRefresh` both return `200` and settle at `COMPLETED`. So the problem is specific to the
*create* path, not to cache concurrency generally.

**Report upstream as:** concurrent cache creation against an in-progress sync returns `500` rather than
the documented `409`, reproducible in about two seconds.

## 5. `cancelFullRefresh` `500`s on a null execution record

```
500 NullPointerException
"Cannot invoke CacheExecutionInfo.getStatus() because
 getLastFullRefreshCacheExecution() is null"
```

Peaka's cancel handler dereferences the full-refresh execution record without a null check, and that
record is created **asynchronously after the trigger returns `200`**. Measured: `triggerFullRefresh`
takes ~2.3s to return and the record appears ~300ms later, so there is a narrow window in which
cancelling NPEs.

At normal API speed the trigger is slow enough to cover the gap — which is why `M` passed at 21s in
isolation and failed at 124s inside a loaded full-suite run. The window only widens under load.

The suite no longer provokes it: `M` lets the refresh finish before cancelling, and the mid-flight
cancel in `tests/races/tier1.js` polls the full-refresh record specifically, so the null precondition
is impossible there too. A `5xx` in that step now means something genuinely new.

## 6. Cache jobs that hang forever, indistinguishably from healthy

A controlled experiment across three tables:

| Table | Rows | Result | Time |
|---|---|---|---|
| `refunds` | 85 | **COMPLETED** | 8.2s |
| `transfers` | **0** | **COMPLETED** | 2.5s |
| `terminal_configurations` | 1 | **RUNNING** | still running when abandoned at 314s |

That rules out both obvious explanations: `transfers` is completely empty and finished in 2.5s, so it is
not emptiness; `refunds` did 85 rows in 8s and `customers` does 505 in under 50s, so it is not volume.

The failure mode is that the execution record is created and then never touched again:

```json
{"status":"RUNNING","error":null,"progress":null,
 "createdAt":"2026-07-29T03:51:48.591Z",
 "updatedAt":"2026-07-29T03:51:48.591Z",
 "finishedAt":null}
```

`updatedAt` identical to `createdAt`, unchanged across 20 polls over 5+ minutes — no error, no progress,
no timeout, no transition to `FAILED`. The job is enqueued and never picked up, and **Peaka reports that
indistinguishably from healthy in-progress work.** Any caller polling `getCacheStatus` has no way to
tell "working" from "dead", which is what makes this worth reporting.

Related: `isCacheable: true` does not imply the table is readable. `issuing_dispute_settlement_details`
is advertised as cacheable but querying it returns a passed-through Stripe error,
`"Unrecognized request URL (GET: /v1/issuing/dispute_settlement_details)"`.

The hang is deliberately **not** asserted anywhere — documented here rather than left as a permanently
red test. `C` caches only the four data tables it asserts on, all verified to sync cleanly in ~37–50s.

## 7. Schema-level cache-status endpoint returns `500`

`GET /data/projects/{projectId}/catalog/{catalogId}/schema/{schemaName}/cache/status` returns
**`500 Internal Server Error`** rather than a list of statuses. The project- and catalog-level
equivalents both work, so this is specific to the schema variant.

## 9. `SqlExec` cannot write at all

The instructor's spec for Peaka Table / Peaka BI Table (`doc2.txt`) assumes DML goes through `SqlExec`
with fully-qualified table names (its own rule 7). It does not work — measured against a real table,
every write statement is rejected:

| Statement | Result |
|---|---|
| `SELECT` | `200`, works normally |
| `INSERT` | `400 "Statement type 'Insert' is not allowed"` |
| `UPDATE` | `400 "Statement type 'Update' is not allowed"` |
| `DELETE` | `400 "Statement type 'Delete' is not allowed"` |
| `CREATE TABLE AS SELECT` | `400 "Statement type 'CreateTableAsSelect' is not allowed"` |

`SqlExec` is a **read-only query engine**. The only way to put data into a Peaka Table through the
Partner API is `PtImport` (CSV, multipart upload) — confirmed by testing every statement type rather than
assuming the endpoint's name implies its capability. This single fact invalidates roughly half of the
spec's 24 scenarios as literally written, since most of them assume SQL-level INSERT/UPDATE/DELETE. The
test suite (`tests/peaka-tables/`) is built around CSV import as the only real write path, and pins the
absence of any alternative — see finding 11.

## 10. CSV import silently accepts a bad mapping and writes `NULL`

The spec's own rule expects a malformed import to be rejected outright, with **zero** rows landing
(its `PT-12`). Measured directly: three of its four "make the import fail" cases do fail cleanly. The fourth
does not.

Mapping a CSV import column to a **CSV header that doesn't exist in the file** does not error. It
succeeds — `200`, `result.processed` matches the row count — and silently writes `NULL` into the mapped
column for every row:

```
mapping: [{ name: "name", csvColumnName: "yok_boyle_baslik" }]   ← header doesn't exist in the CSV
result: 200, processed: 2
SELECT name FROM ... -> [null, null]
```

A typo in a mapping causes **silent data loss**, not a rejection. This is worse than the other three
mapping errors (nonexistent target column, wrong header/index mode, malformed request JSON), which all
fail as expected — it is the one case where the spec's blanket assumption ("all four fail, table ends up
empty") is actively wrong, and the wrong answer is the dangerous one: data appears to have imported
successfully while quietly missing a field.

Asserted in *A bad mapping silently writes NULL instead of failing* as the real, measured behaviour —
not the spec's assumption — so if Peaka ever starts
rejecting this case, the test goes red and says exactly that.

Two secondary quality issues, logged but not hard-asserted (message wording isn't something to pin): the
nonexistent-target-column case leaks a raw backend SQL syntax error (`"syntax error at or near ')'"`)
rather than naming the problem, and the header/index-mismatch case returns an unrelated MinIO storage
error instead of a mapping-validation message.

## 11. No row-level UPDATE/DELETE endpoint exists anywhere

Following directly from finding 9: since `SqlExec` cannot write, the spec's `PT-08` — "Peaka Table's core
value proposition is frequent, precise editing" — has no way to run as written. Confirmed there is no
alternate REST path either, by probing every plausible shape against a real row's system id:

```
PATCH  /table/{t}/rows/{id}   -> 404
PUT    /table/{t}/rows/{id}   -> 404
DELETE /table/{t}/rows/{id}   -> 404
PATCH  /table/{t}/row/{id}    -> 404
POST   /table/{t}/rows/{id}   -> 404
PATCH  /table/{t}/data/{id}   -> 404
```

All generic 404s — no such route exists, under any of the six shapes tried. There is currently **no way
to edit or delete a single existing row** in a Peaka Table through the Partner API. Implemented as
*No row-level UPDATE or DELETE exists anywhere* — not a feature test, a pinned absence: it asserts the
rejection is real (SQL-level and REST-level) and that the row is genuinely untouched afterward, not just
that the API said no. If Peaka ships a row-edit path later, one of these assertions starts returning
something other than a clean rejection and the test goes red to say so.

## 12. BI Table's `displayName` is never respected

Creating a BI Table column with `displayName: "original a"` does not store that value — it stores the
column's own (stripped) name instead:

```
sent:    { name: "flag", displayName: "Flag Label" }
stored:  { name: "flag", displayName: "flag" }
```

**Confirmed independent of the underscore-stripping bug** (finding 13) — a column named `flag`, which has
no underscore to strip, still has its `displayName` silently overwritten. **Confirmed universal across
all 8 supported column types** (VARCHAR/BIGINT/BOOLEAN/DECIMAL/TIMESTAMP/DATE/UUID/TIME) — every one
shows identical behaviour at both creation and update time.

The update endpoint makes this worse than a simple no-op: it returns `200` with a body that **echoes
back the requested `displayName` as if it had been applied**:

```
PUT .../columns/cola  { displayName: "renamed a" }
-> 200 { "id": "-1", "name": "cola", "displayName": "renamed a", ... }   looks like success

GET .../columns  (immediately after, and again after a 3s wait)
-> [{ "name": "cola", "displayName": "cola", ... }]                     never actually changed
```

The `id: "-1"` in the update response is a sentinel, not a real column id — a signal the endpoint may be
constructing a synthetic "as if this worked" response rather than reading back what it actually wrote.
Anyone relying on the API response to confirm a rename succeeded would be fooled; only a second,
independent read reveals it did not happen. Peaka Table's equivalent (`updateInternalTableColumn`) works
correctly for the same inputs, confirming this is BI-Table-specific rather than a general limitation.

Asserted in *BI Table silently ignores displayName on every column change*, deliberately inverted from
what the Peaka Table column scenario checks: it asserts the
`displayName` **stays unchanged** after an update, with a comment noting that if this ever starts
passing the other way, Peaka has fixed it and the assertion needs flipping.

## 13. BI Table names collide after underscore-stripping

BI Table's `create` endpoint silently strips **every** underscore from a requested table name, and the
same happens to column names:

```
sent:    "e2e_test_underscore_probe"
stored:  "e2etestunderscoreprobe"
```

That alone breaks the spec's naming convention (`e2e_auto_...` prefixes assumed to be literal), but the
consequential part is worse: **two different requested names collide into one real table**, and the
second create does not error as a duplicate:

```
create("e2e_auto_a_b")  -> 200, tableName: "eautoab"
create("e2e_auto_ab")   -> 200, tableName: "eautoab"   -- same table, silently
```

Two scenario names that differ only in underscore placement are, underneath, the same table — and the
API gives no indication that the second create didn't actually create anything new. `helpers/withTable.js`
and every BI Table scenario now track and delete the name the **response** returns, never the name sent,
and the leftover-sweep logic checks both the literal and stripped forms.

One open question this raises but does not answer: whether the same collision reaches **data**, not just
identifiers. It could not be tested — Peaka Table's data survives underscores intact (confirmed: a value
like `"has_underscore"` round-trips through CSV import unchanged), but BI Table has no write path through the Partner API
(finding 9 combined with no `import`/`sample` routes existing for `bitable`), so there is currently no way
to check whether BI Table *values* are similarly mangled. Worth re-testing the moment a BI Table write
path is found.

## 14. JSON columns rejected for both internal table kinds

The spec's own comparison table (`doc2.txt` section 0) claims Peaka Table supports JSON columns and only
BI Table excludes it. Measured against a live Peaka Table:

```
addInternalTableColumns(t, [{ name: "payload", dataType: "JSON", ... }])
-> 400 "No enum constant com.peaka.gateway.model.ColumnRequest.ColumnType.JSON"
```

The identical rejection, with the identical message, that BI Table gives. The live server's column-type
enum has no JSON member for **either** table kind — this is a live-API fact contradicting the spec's own
documentation, not a spec typo. It blocks the spec's `PT-03` and `PT-10` (both of which include a JSON column) as
literally written, for both table types. The error message itself is a secondary quality issue worth
separate note: it leaks an internal Java class name (`com.peaka.gateway.model.ColumnRequest.ColumnType`)
directly to the API consumer.

## 15. `getTableSample` is a template generator, and it mostly conforms

**Read the spec before reading the table below.** The spec's `PT-13` expects `2xx` with
`Content-Type: text/csv`, a first row carrying the table's column names as a header, **at least one
*example* data row** ("en az 1 örnek veri satırı"), and that the returned file **is accepted when handed
back to import as a template** — it even suggests downloading the sample and importing it as-is as
optional further validation.

That matters because it settles what the endpoint is *for*: a **template**, not a preview of real rows.
Measured against the spec's actual criteria, Peaka **passes every one of them** — including the
round trip, which returns `200 COMPLETED processed: 5`.

**Measuring this required fixing a client bug first.** `getTableSample()` calls `_request` like every
other method, which always tried `res.json()` — but this endpoint returns `Content-Type: text/csv`, so
that throws and the caller silently got `body: null`, regardless of what the table actually contained.
Confirmed through the method itself, unfixed: `null` in all four states tried. `_request` gained an
opt-in `raw: true` mode (`res.text()` instead of `res.json()`), and `getTableSample` now uses it —
additive, no other caller touched.

Measured 2026-08-10, through the fixed method:

| Table state | Response |
|---|---|
| Table doesn't exist | `200`, body is five blank lines (`"\n\n\n\n\n"`) |
| Real table, declared columns `name`/`age`, zero rows | `200`, header is `text,name,age` — `text` was never declared — rows are `"sample text","sample text",<random int>` |
| Same table, **after** importing real rows (`alice`/30, `bob`/40) | `200`, identical synthetic pattern — real data never appears |
| A different table, declared column `city` only | `200`, header is `text,city` |

The generator is genuinely type-aware — every VARCHAR-typed column comes back `"sample text"`, every
BIGINT-typed column a random integer, every DECIMAL a random decimal — and the header does track the
table's real column names. Always exactly 5 rows, regardless of the table's real row count. Synthetic
content is **correct behaviour** here, not a defect: the spec asked for example rows.

**The one real deviation is narrow:** the header carries a leading `text` column the caller never
declared. Peaka adds `text` to every internal table itself (see finding 19's system-column list), so it
is a real column — but a template that hands back a column the user did not create invites them to fill
it in without knowing what it is.

**Worth knowing, though it is not a spec violation.** The spec's own suggested validation — import the
sample as-is — succeeds, which means it appends 5 rows of `"sample text"` to the table. Inside a test
that is harmless: the spec's cleanup step is `PtDelete`, and finding 21 confirms dropping the table
really does purge it. For a *user* running the obvious template workflow against a real table it is less
harmless, because finding 20 leaves no way to remove those 5 rows short of dropping the table.

The mechanism is worth naming: the sample generator is careful to emit **type-valid** values, and import
validates **strictly by type** (finding 18). Both behaviours are individually correct, and together they
guarantee synthetic data passes validation cleanly. A sloppier generator would have been caught by the
importer.

Asserted as *The sample endpoint returns a type-aware template with example rows*, pinning: the
nonexistent-table response exactly, the header format, the
type-conditioned canned values, and that an unmistakable imported marker value never appears in the
sample body.

## 16. Trino wants `OFFSET` before `LIMIT`

`SELECT ... ORDER BY x LIMIT 20 OFFSET 140` — valid Postgres and MySQL — is a Trino syntax error:

```
"mismatched input 'OFFSET'. Expecting: <EOF>"
```

Trino's grammar is `[ORDER BY ...] [OFFSET n] [LIMIT n]`, the reverse order. Not a Peaka bug, but worth
recording since it silently breaks SQL ported from a more common dialect rather than producing an obvious
error about ordering — `mismatched input 'OFFSET'` reads like a typo, not a clause-order rule.

## 17. Smaller quirks

None are severe alone, but each silently breaks naive client code and several contradict the reference:

| Behaviour | Detail |
|---|---|
| **Two spellings of "cancelled"** | Cache statuses use `CANCELLED` (two L's); materialized query statuses use `CANCELED` (one L). A polling loop handling only one spelling waits forever on the other — this bit the materialized-query test during development and looked exactly like a hang |
| **Deleted resources return `400`, not `404`** | Both `getQuery` and `getConnection` on a deleted id return `400` with an explanatory message |
| **`COMPLETED` doesn't mean "materialized"** | A freshly created materialized query reports `status: COMPLETED` with `lastExecutionStartTime` and `lastUpdateTime` both `null`. It means "nothing in flight", not "the data exists" |
| **Stale status after triggering a refresh** | The status endpoint keeps returning the *previous* terminal status until the new run actually starts, so polling for "any terminal status" right after a refresh returns the old value instantly. **Waiting for a specific status only half-fixes it** — the stale value may already *be* the status you are waiting for, and then the poll is satisfied having observed nothing. The reliable signal is `lastExecutionStartTime` changing |
| **Malformed cache schedules silently ignored** | `PUT /cache/{id}` with an invalid ISO-8601 expression returns `200` and keeps the old schedule, instead of the documented `400` |
| **Table statistics unsupported for Stripe** | `400 "Catalog type: stripe is not being supported yet"` — but works for Postgres (`200`, real per-column stats), so this is connector-specific, not an unbuilt Peaka feature. See the attribution table above |
| **`transpileSql` returns `{query}`** | The reference documents `{result}` |
| **Metadata refresh status is lower-kebab** | Returns `not-active`; the reference documents `NOT_ACTIVE` |
| **Exporting an empty table fails** | `Export Table` on `transfers` (0 rows) returns `FAILED` with `"Trino-native export produced no files at s3a://export/..."`. A zero-row export produces no file rather than an empty one, so a caller cannot distinguish "no data" from "the job broke" |
| **`Get Connection Detail` returns less than `getConnection`** | Despite the name it gives `{ type }` alone, where the plain read gives id/name/type/url. No credential is exposed by either — `G` scans both |
| **Executing a saved query keys off `id`** | Not `queryId`. `queryId`, `queryRefId` and `savedQueryId` all return `400`, as does passing the id as a JSON number |
| **`Update Query Path` is `PATCH`, not the documented `PUT`** | The reference gives `PUT /api/queries/{queryId}/path`. Both halves are wrong: the verb is `PATCH` (`PUT` and `POST` return `405 Method Not Allowed`), and the route is project-scoped like every other query endpoint — the bare `/api/queries/...` form returns the generic framework `404`. The `405`-versus-`404` split is what identified the route as real but the verb as wrong |
| **Moving a query creates a folder that outlives it** | Setting a query's path to one that doesn't exist creates a folder entity. Deleting the query does **not** remove it — verified: the folder was still listed afterwards. Anything moving queries must track and delete folders separately, which is why `helpers/cleanup.js` does |
| **Credential validation is layered, and the layers report differently** | `credential: {}` and `credential: { token: "" }` are rejected by *credential* validation as `400 INVALID_CREDENTIALS`; omitting `credential` entirely is rejected earlier by *schema* validation as `400 Bad Request` — *"Missing property 'credential'"*. Good behaviour, asserted separately in `G` so a future collapse into one generic error would be noticed |
| **`INVALID_CREDENTIALS` leaks an internal route** | The error body embeds an internal service path, `/internal/connection-secret/{projectId}/{uuid}`. Harmless to a legitimate caller but it exposes internal topology in a client-facing error — worth mentioning upstream |
| **Double aggregates come back in scientific notation** | `SUM(amount)` over a Postgres `double` column returns the string `"1.254740786E7"` rather than `"12547407.86"`. `Number()` parses it, but a non-JS client or anything doing string comparison, regex matching or decimal parsing would break on it |
| **Numeric columns come back as strings** | `SELECT amount FROM charges` returns `"15000"`, not `15000`. Any caller doing arithmetic gets string concatenation instead of addition. Asserted in `C` so that if Peaka starts returning real numbers the suite goes red and the change gets noticed |

---

## 18. Import validates values strictly, and mappings not at all

A prediction that turned out **wrong**, which is why it is worth recording. Finding 10 shows a bad
*mapping* silently writes `NULL`, so the reasonable expectation was that the value-parsing path in the
same endpoint would be equally lax — and that would have been strictly worse, since a mapping typo is a
caller error in metadata while a bad value is real data discarded on a request that reports success.

It is the opposite. Measured 2026-08-10, each bad value in its own import (a single CSV carrying all
five stops at the first — the error even names the CSV line number):

| Value | Column type | Result |
|---|---|---|
| `abc` | BIGINT | `400 invalid input syntax for type bigint: "abc"` |
| `2024-13-45` | DATE | `400 date/time field value out of range: "2024-13-45"` |
| `maybe` | BOOLEAN | `400 invalid input syntax for type boolean: "maybe"` |
| `9999999999999999999999999` | BIGINT | `400 value "999…" is out of range for type bigint` |
| `not-a-uuid-at-all` | UUID | `400 invalid input syntax for type uuid` |

Every message **names the offending value**, and the batch form also names the line and column — the
best error messages in this API by a wide margin, and a marked contrast to the raw SQL syntax error a
bad mapping produces (finding 10).

**The rejection is atomic.** Each CSV above began with a valid row; `COUNT(*)` is `0` afterwards, so
nothing partial is written. That is precisely the "yarım import kabul edilmez" guarantee the source doc
asks for — honoured for values, ignored for mappings.

**So the same endpoint applies two completely different standards**, and the lax half is the one that
loses data. If value parsing ever drifts toward the mapping side, that is a serious regression with no
external symptom, which is why *Invalid values are rejected strictly and atomically* asserts the strict
behaviour rather than merely observing it —
the unusual case in this folder of a test pinning a guarantee instead of a deviation.

## 19. The 100-row cap does not apply to internal tables

Measured while probing for finding 18, because no internal table in this repo had ever held more than
10 rows and every future count-based assertion depends on the answer:

| | Result |
|---|---|
| Import 150 rows | `200`, `processed: 150` |
| `COUNT(*)` | **150** |
| `SELECT … LIMIT 500` | **150 rows** |

Uncapped. That is the **fifth** independent confirmation the cap belongs to the Stripe connector rather
than to Peaka — after raw queries, exports, materialization and saved queries against Postgres. Internal
tables are Peaka's own storage with no upstream API to paginate, so the same explanation holds: the cap
is a symptom of Stripe's List API page size, not of Peaka's read path.

**Two corrections to earlier notes in this repo, both found the same way.** `helpers/peakaClient.js`
recorded that a Peaka Table carries three system columns (`_id`, `_version`, `_created_time`).
`SELECT *` returns **fourteen** columns on a six-column table — the eight undeclared ones are `_id`,
`_version`, `_created_time`, `_created_by`, `_last_modified_time`, `_last_modified_by`, `_session` and a
bare `text` column. BI Table additionally carries `_operation`. Any assertion comparing a column list
against what was declared must filter all of them, and `SELECT *` is not a safe way to read a row back.

## 20. CSV import appends unconditionally, so a Peaka Table can only grow

Finding 9 established that `SqlExec` cannot write and finding 11 that no row-level endpoint exists. Both
leave the obvious follow-up open: since CSV import is the *only* write path, what does importing a second
time do? Every scenario in `tests/peaka-tables/` had imported into a fresh table exactly once, so nobody
had checked.

Measured 2026-08-11:

| Action | `processed` | `COUNT(*)` |
|---|---|---|
| Import 3 rows into an empty table | 3 | 3 |
| Import the **byte-identical** CSV again | 3 | **6** |
| Import a different 2-row CSV | 2 | **8** |

Import **appends**, always. There is no replace mode, and no deduplication even for a byte-identical
file — the duplicate rows come back with **different `_id`s**, so they are genuinely new rows rather than
one row read twice. `result.processed` counts the rows in *that* request, never the table total, so a
caller treating it as "how big is the table now" is correct exactly once.

**The combination is what matters.** Append-only, no `UPDATE`, no `DELETE`, no dedup — a Peaka Table can
only ever grow. A row imported by mistake cannot be corrected or removed through any endpoint this client
has found; the only recovery is dropping the whole table and rebuilding it (finding 21 confirms that
really does clear it). Anyone treating a Peaka Table as a maintainable store rather than an append log
will silently accumulate duplicates.

Asserted as *Repeated import appends instead of replacing*, with a failure message noting that a future
`COUNT(*)` of 3 would mean Peaka gained replace semantics — a *fix* worth noticing, not a regression.

## 21. Deleting a table purges its data and its schema

Every scenario in `tests/peaka-tables/` opens with a best-effort "clean up any leftover table from a
previous run" step and then assumes a blank slate. That assumption had never been verified. A soft delete
would mean a "fresh" table could carry a previous run's rows, and several green assertions would be
passing by luck — invisible from outside.

Measured 2026-08-11, and delete is a genuine hard drop:

| Step | Result |
|---|---|
| `deleteInternalTable` | `200`, gone from `listInternalTables()` |
| `SELECT` from the deleted table | `400 "Table 'peaka.table.…' does not exist"` |
| Recreate the **same name** | `200`, but only the 8 system columns exist |
| `SELECT` a previously declared column on it | `400 "Column 'name' cannot be resolved"` |
| `COUNT(*)` on the recreated table | `0` |
| Import a row after re-adding columns | new `_id`, **not** any previously-used value |

The schema half is the part most likely to catch someone out: **recreating a table by the same name does
not restore the columns you declared on it.** You get a blank table carrying only Peaka's own system
columns, and every user-declared column has to be added again.

`_id` is also not a per-table sequence — a row in the recreated table gets an id well above the deleted
rows' rather than restarting, consistent with a globally monotonic (snowflake-style) generator. The
scenario asserts only **non-reuse**, not monotonicity: ordering is an internal detail Peaka may change,
whereas a recycled id would mean a stale reference silently resolving to an unrelated row.

## 22. `isUnique` and `isNotNull` are silently discarded at column creation

Not an enforcement question — the flags are never **stored**. Create a column with them set, read it
straight back, and they are `false`:

| Sent | Read back |
|---|---|
| `isUnique: true` | **`false`** |
| `isNotNull: true` | **`false`** |
| `desc: "some text"` | **`null`** |
| `defaultValue: "THE_DEFAULT"` | `"THE_DEFAULT"` ✓ |

**`desc` is the third one, found later** (2026-08-12) while investigating finding 28. It is discarded both
by `addInternalTableColumns` and by `updateInternalTableColumn` — `200` either way, `null` on read-back.

**And the field is not unimplemented — it works everywhere else.** `listColumns` on a *Postgres* table
returns real descriptions straight from the database:

```
actor.actor_id -> desc: "Primary key. Unique identifier for each actor.
                         Generated from actor_actor_id_seq sequence."
```

So Peaka reads and surfaces column descriptions for connector-derived tables, and silently drops them for
its own internal ones. That is a narrower, more specific defect than "descriptions are not supported", and
it is why finding 28 cannot be reproduced on a table we own: there is no way to give one a description.

The call returns `200`. Nothing in the response indicates anything was dropped. This is the same shape
as finding 12 (BI Table's `displayName`): **a documented, settable field whose write silently does not
take.** The import behaviour follows trivially and was confirmed anyway — two duplicate values import
cleanly into the "unique" column, and an empty value lands as `NULL` in the "not null" one.

**`defaultValue` is the control, and it works end to end.** A CSV whose mappings omit that column
entirely produces rows carrying the default rather than `NULL`. That is what makes the other two a
targeted defect rather than the column body being ignored wholesale — and it is asserted, because it
would be easy to assume the whole feature is dead and stop using the part that works.

**What the docs say, checked before writing any assertion.**
[add-column](https://docs.peaka.com/api-reference/data--internal-tables/add-column) describes the fields
only as *"The not null flag for the column"*, *"The unique flag for the column"*, *"The default value of
the column"* — it never states whether they are enforced. So this is deliberately asserted as a **failed
round trip** rather than a failed constraint: the docs make no enforcement promise to hold Peaka to, but
they plainly present all three as settable properties, and two of them are not.

**Why a customer hits it.** Marking an id or email column unique is ordinary modelling, and `isUnique` is
offered as a first-class field, so setting it is the obvious move. The call succeeds; nobody re-reads the
column to check the flag survived. They then import a CSV merged from two systems — the classic source of
duplicate emails — and duplicates land silently. Per finding 20 those rows can never be removed.

## 23. A Peaka Table and a BI Table with the same name stay fully isolated

Verified working, and pinned, because the failure mode it guards against is silent data loss.

The spec's `CMP-01` asks for exactly this — *"the two live independently, data does not mix, deleting one
does not affect the other"* — but **its own version never creates the collision it tests for.** BI Table
strips every underscore (finding 13), so requesting `e2e_auto_cmp_same` twice yields a Peaka Table named
`e2e_auto_cmp_same` and a BI Table stored as `e2eautocmpsame`: two different names that could not collide.

The scenario therefore covers both cases, and builds the real collision deliberately by creating the Peaka
Table under BI Table's already-stripped name. Measured 2026-08-11 — isolation holds on every axis:

| Check | Result |
|---|---|
| Same requested name | Two different stored names |
| `listInternalTables()` / `listBiTables()` | No leak in either direction |
| Each `SELECT` under the shared name | Sees only its own columns and rows |
| Delete the Peaka Table | BI Table still listed **and** still queryable |

**A customer reaches the collision without trying.** Nobody needs to name two things alike deliberately:
create a BI Table `order_items`, Peaka stores it as `orderitems`, and a Peaka Table called `orderitems`
already exists. The platform manufactured a collision the customer never chose and cannot see from the
names they typed. Had deletion leaked across namespaces, removing one would destroy the other —
unrecoverable per findings 20 and 21.

It also de-risks this suite: [`helpers/cleanup.js`](helpers/cleanup.js) deletes by name from
`createdInternalTableNames` then `createdBiTableNames`, so a cross-namespace leak would have had our own
cleanup destroying resources it never created.

## 24. The 100-row cap propagates through federated joins

**The most consequential form of finding 1.** Peaka advertises cross-source querying as a headline
capability — [peaka-query](https://docs.peaka.com/connecting-your-data/peaka-query) says Peaka Queries
let you *"combine data from different Peaka Tables and other connected data sources."* Meanwhile the API
reference documents **no row cap at all**: `execute-query` describes `limit` as *"Maximum number of rows
to return"* and promises no ceiling.

So an **undocumented** cap silently degrades a **documented** feature. Measured 2026-08-11:

| Query | Result |
|---|---|
| Stripe `customers`, queried directly | **100** distinct (505 exist) |
| Internal table `CROSS JOIN` Postgres | **50,000** rows (2 × 25,000) — uncapped |
| Internal table `CROSS JOIN` Stripe `customers` | **100** distinct Stripe rows, **200** join rows |

The Postgres leg is the control and it is load-bearing: federation happily produces 50,000 rows when
neither side is Stripe, so the join mechanism is not the limiter. Put a Stripe table on one side and the
result is computed over 100 of its 505 rows.

**Why this is worse than the plain cap.** A truncated `SELECT` at least *looks* truncated — you asked for
rows and got fewer. An aggregate over a truncated join looks like **an answer**. A customer joining their
own customer list against Stripe charges to compute revenue gets a number, with no error, no warning and
no flag, and four fifths of the Stripe data never entered the calculation.

This is the **sixth** independent confirmation that the cap belongs to the Stripe connector — after
queries, exports, materialization, saved queries and internal tables — and the first showing it crosses
into federated results.

## 25. A saved query re-binds silently to a recreated table

A saved query is stored as **SQL text** and its table name is resolved at execution time. The query
object and the query execution therefore fail independently:

| Action | Running the saved query | `getQuery` / `listQueries` |
|---|---|---|
| Drop a column the query `SELECT`s | `400 "Column 'doomed' cannot be resolved"` | Still `200`, `inputQuery` unchanged |
| Delete the whole table | `400 "Table '…' does not exist"` | Still `200`, still listed |
| Recreate the table, same name, **different data** | **`200` — returns the new data** | Still `200` |

**No 5xx at any point** — every dangling reference degrades into a clean, specific `4xx`. That was the one
invariant worth asserting before measuring anything, because finding 3 is the precedent: deleting a cache
once left a table permanently unreachable.

Two consequences worth knowing:

- **Deleting a table never deletes the queries built on it.** A project accumulates queries that are
  broken until the name reappears — which is arguably right, but nothing tells you they broke.
- **The re-bind cuts both ways.** It is exactly what you want when you reload a table you own. It is
  exactly what you do *not* want when someone else creates an unrelated table that reuses the name: the
  dashboard keeps working and quietly starts reporting different data, with no error anywhere.

## 26. An export round-trips through import — but carries eight system columns

The everyday loop: export a table, open it in Excel, upload it again. Measured 2026-08-11 with 150 rows,
deliberately past the Stripe cap:

| Step | Result |
|---|---|
| `createTableExport("1", "table", …)` | `202 PENDING`, then `SUCCEEDED` with `rowCount: 150` |
| Downloaded file | 151 lines — header plus **all 150 rows** |
| Re-imported into a second table | `200`, `processed: 150`, values identical |

**The export is not capped.** That is the **seventh** independent confirmation the 100-row cap belongs to
the Stripe connector. It matters here specifically because the cap *does* reach Stripe's export files
(finding 1), so the export path was a plausible place for it to reappear on internal tables. It does not.

**But the exported file is not directly re-importable.** The header is:

```
_id,_version,_created_time,_created_by,_last_modified_time,_last_modified_by,_session,text,<your columns>
```

All eight system columns come along. Mapping every header column on the way back in would target Peaka's
internal columns, so a caller has to filter the mapping down to the columns they actually declared.
`createTableExport` takes no `includeSystemColumns` option — only `createQueryExport` does — so for a
table export the filtering has to happen client-side.

**Note the asymmetry with the sample endpoint.** The spec *requires* `getTableSample`'s output to be
importable as-is, and it is (finding 15). Peaka produces two CSV-shaped outputs and only one of them
round-trips without editing — the one explicitly designed as a template.

## 27. A materialized query over an internal table never goes stale

**Peaka's docs are explicit** about what materialization means:
[what-is-materialized-query](https://docs.peaka.com/connecting-your-data/what-is-materialized-query)
says results are *"refreshed on a schedule or manually; data can be slightly stale between refreshes."*
The whole trade is currency for speed.

Over an internal table there is **no snapshot at all**. Measured 2026-08-11:

| Step | Base table | Through the materialized query |
|---|---|---|
| Seed 3 rows, then force a refresh | 3 | 3 |
| Append 2 rows, **no refresh** | 5 | **5** ← not stale |
| Refresh again | 5 | 5 |

**The first attempt to measure this was ambiguous, and the trap is worth recording.** A freshly created
`MATERIALIZED` query reports `status: COMPLETED` with `lastExecutionStartTime: null` — that means
"nothing in flight", not "materialized" (the same trap `tests/stripe/n-materialized-queries.js`
documents). Reading it in that state proves nothing, because no execution has ever run. The scenario
therefore forces a real materialization first and asserts the timestamps are populated, so the staleness
check afterwards is meaningful.

**This is the exact inverse of finding 2**, and the pair is the interesting part — same feature, opposite
failure, decided by what sits underneath:

| Source | Materialization behaviour |
|---|---|
| Stripe (uncached API connector) | Snapshot, **frozen at the capped 100** of 505 rows, permanently |
| Postgres (database) | Snapshot of the whole table |
| Peaka Table (internal storage) | **No snapshot** — tracks the base table live |

A plausible explanation is that materialising Peaka's own storage would be pure overhead, so it is a
deliberate no-op. That is defensible — but it is undocumented, and it silently breaks the one thing
customers materialise *for*: freezing figures. Someone snapshotting month-end numbers gets a live view
whose "snapshot" keeps moving, with the documentation telling them the opposite.

## 28. A table comment breaks `createCache`, and the crash is disguised as a 4xx

Found by pointing the existing suite at a **second Peaka project** — the whole reason the Postgres folder
exists. Nothing in the tests changed; only the database did.

`createCache` on a table whose Postgres `COMMENT` is not valid JSON fails with a **parser error** instead
of its proper rejection:

```
400 {"error":"WrongRequestException",
     "message":"Unexpected JSON token at offset 8: Expected EOF after parsing, but had a
                instead at path: $\nJSON input: Stores actors appearing in films.",
     "errorCode":null}
```

`"Stores actors appearing in films."` is the Sakila `actor` table's comment. Peaka reads the description
out of Postgres' catalog and runs it through a JSON parser.

**Measured across the whole schema, 2026-08-12:**

| | Result |
|---|---|
| Tables rejecting with `TABLE_NOT_CACHEABLE` | **27 of 28** |
| Tables rejecting with a parse error and `errorCode: null` | **1** (`actor` — the only commented table) |
| `listColumns`, `isTableCached`, `SELECT COUNT(*)` on that table | all `200`, identical to uncommented tables |

So the fault is **isolated to `createCache`**, and the parse happens *before* the cacheability check —
tables without comments reach the correct rejection.

**Three consequences.** The documented rejection path is destroyed for commented tables; `errorCode` is
`null` so a client has nothing to branch on and must string-match a parser message; and the table's
comment leaks into an error message.

**The disguise is the more interesting half.** Peaka returns **`400 WrongRequestException`** — *the client
sent something wrong*. The request was entirely valid; what failed is Peaka parsing its own stored
metadata. A server-side crash wearing a client-error status **evades the 5xx warning channel completely**
(`helpers/serverError.js` keys on status ≥ 500), so the instructor's rule *"a 5xx is always a bug"* has a
blind spot: a server bug returned as `4xx` is invisible to it. The only thing that caught this was the
assertion that a rejection carries a usable `errorCode`.

**Why it is reported rather than asserted.** The input is outside this suite's control in both
directions, and the distinction between table and column descriptions matters here:

| | Readable through the API? | Settable through the API? |
|---|---|---|
| **Column** description | **Yes** — `listColumns` returns `desc` for Postgres columns | No (silently dropped on internal tables — finding 22) |
| **Table** description | **No** — `listTables` has no such field, 0 of 28 | No |

The comment that breaks `createCache` is a **table** comment, so it is invisible in both directions. Every
alternative route is closed too: `information_schema.tables` exposes only catalog/schema/name/type,
`obj_description('…'::regclass)` is rejected by Trino's parser, and `pg_description` is not resolvable
through the connector. **The only reason its text is known at all is that the bug itself echoes it back**
in the error message.

Which tables trigger it therefore depends entirely on whose schema you point at, so an assertion would
pass or fail on the database rather than on Peaka. `PG-A` now surveys the schema, asserts only what holds
anywhere — no `5xx`, and at least one clean rejection — and **reports** the malformed count with the
leaked comment.

**Reproduction** (`film_actor` is the control — same call, correct rejection):

```
createCache(public.actor)       -> 400, errorCode null, JSON parse error
createCache(public.film_actor)  -> 400 TABLE_NOT_CACHEABLE
```

**Untested implication.** The parser is lenient — it consumed the bare word `Stores` and only failed at the
*next* token — so a single-word comment may well parse cleanly. Untestable here: only one commented table
exists and no API can create another.

## 29. BI Table is writable in Studio and read-only through the Partner API

**This corrects a claim this document made for weeks.** It said BI Table "has no write path at all",
which was measured against an empty BI Table and was too strong. Rows entered through **Studio** land
perfectly well, and the Partner API can read them in full. What the API cannot do is *write* them.

**What the docs promise.**
[peaka-bi-table](https://docs.peaka.com/connecting-your-data/peaka-bi-table) is explicit: a BI Table can
*"execute operations like row-by-row updates, deletions, and insertions"* and is *"ideal for the storage
of event data, particularly excelling when handling bulk data insertion from various sources."* Four
capabilities, stated plainly.

**What the Partner API delivers**, re-measured 2026-08-13 against a BI Table holding 8 real rows — so
this is no longer the empty-table result:

| Attempt | Result |
|---|---|
| `SqlExec INSERT` / `UPDATE` / `DELETE` | `400 "Statement type 'X' is not allowed"` |
| `POST /bitable/{t}/import` | `404` — the Peaka Table equivalent of this route **works** |
| `POST /bitable/{t}/` + `rows`, `row`, `data`, `records`, `insert`, `values` | `404`, all six |
| Row count before / after every attempt | **8 / 8**, and every column value byte-identical |

**The read side, by contrast, is complete**: `SELECT *`, single-column projection, `WHERE` filters,
`GROUP BY`, joins to a Peaka Table, async CSV export (`202`), and saved queries over it (`200`) all work.

**So the question changes shape.** It is not "is BI Table finished?" — the feature demonstrably works. It
is **why the write path is UI-only when the documentation describes it as a property of the table.**
Anyone building on the Partner API can read a BI Table but can never populate one, and nothing in the
docs says so.

`_operation` also revealed its purpose here: every Studio-inserted row carries `"INSERT"`. It is the
ninth system column, the one Peaka Table lacks, and until a populated BI Table existed it had never held
a value — consistent with BI Table being an event/change-log store.

Asserted as *A populated BI Table refuses every documented write*, which re-reads the whole table after
every attempt rather than only the row count: an `UPDATE` that changed a value in place would leave the
count untouched.

## 30. `createCache` cannot refuse an internal table — it fails looking one up

The Postgres folder establishes what a correct refusal looks like: `isCacheable: false` in the metadata,
**and** `createCache` acting on it with `400 TABLE_NOT_CACHEABLE`. A flag can be stale; a rejection
cannot, which is why `PG-A` asserts both halves.

Internal tables manage only the first half. Measured 2026-08-13 across both kinds, empty and populated:

| Call | Result |
|---|---|
| `isCacheable` / `supportedCacheTypes` | `false` / `[]` — correct |
| `createCache(schema "bitable")` | `400 "cannot find table or properties: \"table0658…\" in schema: \"schemamapper9lbuaggx…\""`, `errorCode: null` |
| `createCache(schema "table")` | same shape, different mangled identifier |

The request never reaches the cacheability check. It dies looking up an internal, mangled table
identifier, and the caller gets a message about Peaka's own storage layout instead of an answer to the
question they asked.

**This is the second endpoint response today whose `errorCode` was eaten by an unrelated internal
failure** — finding 28 is the first, on a table carrying a Postgres comment. Two independent causes,
same endpoint, same `null` `errorCode`, which makes it a property of `createCache`'s error handling
rather than a one-off. A client written the way `PG-A` is — *try to cache, handle `TABLE_NOT_CACHEABLE`* —
has nothing to branch on and must string-match a message about internal schema names.

Asserted as *Cache creation on a BI Table fails before it can be refused*, which needs no fixture and so
runs in any project.

## 31. Adding an existing column leaks the whole PostgreSQL exception

Found while migrating BI Table data into a Peaka Table. Every internal table is created with a default
`text` column, so re-adding one produces a `400` — reasonably. What it returns is not reasonable:

```
{"errorCode":100,"message":"org.postgresql.util.PSQLException: ERROR: duplicate key value violates
 unique constraint \"sm_column__name__table_name_key\"\n  Detail: Key (_name, _table_name)=(text,
 e2e_auto_bi_export_dst) already exists.\n  Where: SQL statement \"INSERT INTO
 schema_mapper_9lbuaggx_4128748030302570328.sm_column (_id, _name, _display_name, _table_name, …)
 …PL/pgSQL function abstract_schema_mapper.create_column_props_with_id_corrected(text,text,jsonb)
 line 16 at EXECUTE…"}
```

Handed to the caller: the internal schema name and its project-scoped suffix, the internal `sm_column`
table and its constraint name, the generated `ALTER TABLE`, two PL/pgSQL function names with line
numbers, and the full argument list. A duplicate column is an ordinary, expected mistake — it should
produce "column already exists", not a stack-trace-grade dump of the storage layer.

Same family as findings 28 and 30: an internal failure surfacing raw through a `4xx`. Here `errorCode` is
at least populated (`100`), so the caller can branch — the problem is purely the disclosure.

Not asserted. The scenario that found it now reads the destination's existing columns and adds only what
is missing, which is what a caller should do anyway.

## 32. MongoDB's `_id` is invisible, and the obvious way to filter on it is broken

Found while building the first MongoDB scenario (`tests/mongodb/mo-a-discovery.js`, project `z8mo8AxO`,
catalog `connect2`, collection `e_commerce.commerce`, 25,000 rows). Every MongoDB document has an `_id` —
it is the collection's real primary key — and Peaka drops it from the schema mapping entirely:

- `listColumns` on `commerce` returns 8 columns. `_id` is not one of them.
- `SELECT *` returns the same 8 fields. No `_id` key on the row.

So a caller relying on either endpoint to discover what's queryable would never learn `_id` exists at all.

It is still there if you ask for it **by name**, but two things go wrong:

**The value is unusable as returned.** `SELECT _id` succeeds and returns a string like
`"6a 4c 8d 06 7a 40 cc b7 fa ad ba 17"` — Trino's default `VARBINARY` rendering, hex byte pairs joined by
spaces — not the 24-character hex string (`6a4c8d067a40ccb7faadba17`) any MongoDB tool or driver would
recognize as an ObjectId. Nothing in the response says to strip the spaces or that this is even an
ObjectId; you'd have to already know Trino's rendering convention.

**The obvious filter fails outright.** `WHERE _id = '<hex>'` — the first thing anyone would try — is
rejected:

```
{"errorCode":100,"message":"Unexpected parameters (ObjectId, varchar(24)) for function $operator$EQUAL.
 Expected: $operator$EQUAL(T, T) T:comparable"}
```

The declared type is a distinct `ObjectId` type, not `varchar` or `varbinary`, and Trino won't implicitly
compare it against either.

**There is a working path**, which is why this is recorded as a finding rather than "no way in at all":

```sql
SELECT CAST(_id AS VARCHAR) AS id_hex FROM "connect2"."e_commerce"."commerce" LIMIT 1
-- -> '6a4c8d067a40ccb7faadba17', the standard hex form

SELECT * FROM "connect2"."e_commerce"."commerce" WHERE _id = objectid('6a4c8d067a40ccb7faadba17')
-- -> works, returns the matching row
```

Both `CAST(_id AS VARCHAR)` and Trino's MongoDB-connector `objectid('<hex>')` function work — the second
is a Trino/Presto MongoDB-connector convention, undocumented anywhere in Peaka's own docs. Someone would
have to already know Trino's MongoDB connector internals to find it; nothing in Peaka's API surface points
there.

Not the same defect family as 28/30/31 (no internal exception leaks, no `5xx`) — this is a pure
discoverability and ergonomics gap: a real primary key that exists, is queryable, and yet is unreachable by
anyone who only reads `listColumns` and writes ordinary SQL.

Asserted rather than merely observed: `mo-a-discovery.js` pins both the absence (`listColumns`/`SELECT *`
never carry `_id`) and the broken naive path (`WHERE _id = '<hex>'` returns `400`), then proves the
workaround still round-trips to the right row — so a future Peaka release that starts exposing `_id`
properly shows up here as a failure, and one that closes the `objectid()`/`CAST` path without fixing the
underlying visibility shows up as a different, more useful failure.

## 33. Table statistics are implemented for Postgres only — not Stripe, not MongoDB

`tests/postgres/pg-g-catalogs.js` records that `getTableStatistics` returns `200` with real per-column
statistics for a Postgres catalog, while Stripe's equivalent (`tests/stripe/h-catalogs.js`) gets a clean
`400 "Catalog type: stripe is not being supported yet"`. Read with only those two data points, the obvious
generalization is "database connectors get it, API connectors don't" — and that generalization is wrong.

Measured live against the third connector, `connect2` (MongoDB), project `z8mo8AxO`:

```
GET .../tables/commerce/statistics  (catalogType: peaka_mongodb)
-> 400 {"errorCode":100,"message":"Catalog type: peaka_mongodb is not being supported yet"}
```

The exact same rejection Stripe gets — on a connector that queries a real, live database directly through
Trino, exactly like Postgres does. So the two-connector pattern was an accident of which two connectors
happened to be tried first. The real shape is narrower and less interesting than "database vs API": Postgres
is the only connector with this feature built, and nothing about being a database connector predicts it.

|  | `getTableStatistics` |
|---|---|
| Stripe | `400`, unsupported |
| Postgres | `200`, real statistics |
| MongoDB | `400`, unsupported |

Not a bug — an unimplemented feature is not a defect — but worth recording precisely, because the
Postgres-only shape is easy to mis-generalize from two points and this suite very nearly did. `MO-G`
asserts the `400` deliberately, as the mirror image of `PG-G`'s `200`, so neither scenario can be "fixed" to
agree with the other without the change being a real regression or a real improvement.

## Server errors now have their own channel

Separate from a product finding: the instructor's spec states a firm rule (rule 6 of 8) — *a 5xx
response is always a bug, never an acceptable outcome, even in a negative scenario*. This suite had no way
to act on that. `helpers/assert.js` made no distinction between a `500` and a `400` at all, and **two
tests were already passing green while receiving a `500`**, with the only trace a `console.log` that
reached no report:

- `M`'s schema-wide cache-status step — the known bug in finding 7, tolerated with `[200, 500]`
- Tier 1's duplicate-`createCache`-mid-sync step — the known bug in finding 4, status logged, never
  asserted

Both are genuine Peaka bugs, already documented above, and outside this suite's control — making them
permanently fail would just train everyone to ignore red in this suite, which is how a real regression
would eventually hide. Both still pass. What changed is that every 5xx anywhere in the suite is now
recorded with its scenario, step, and (where tolerated) the rationale, surfaced in a terminal banner, in
`test-results/coverage.json`, and in the dashboard as a distinct state — visually separate from both a
clean pass and a failure. See `helpers/serverError.js`.

## Verified working: cache refresh does pick up source changes

Not a bug — a question that had never been answered, and worth recording because the answer was genuinely
uncertain before it was measured. `M` proves the refresh endpoints *respond* correctly, but a refresh that
returned `200` and silently fetched nothing new would have passed every assertion in it.

Scenario `O` adds a real customer to Stripe and watches what the cache does. Measured 2026-08-03:

| Step | Result |
|---|---|
| Before any refresh | The new customer is **not** visible — confirming the query reads the cached snapshot, without which the rest proves nothing |
| After `triggerIncrementalUpdate` | **Visible.** Incremental sync *does* detect inserts — the open question going in |
| Row count | Rose by exactly one, so the refresh reconciles rather than duplicating |
| After deleting upstream + full refresh | Removal reflected, count back to baseline |

Both directions work. The scenario still tries incremental first and falls back to a full refresh, and
reports which one succeeded rather than asserting it — if a future connector version stops detecting
inserts incrementally, that surfaces as a logged difference rather than a red test, and this table is
what it should be compared against.

### Incremental really is incremental — and it handles all three change types

Extended 2026-08-04 to cover updates and deletes, and to read the `progress` counters, which nothing had
ever done with real data. The only previous look was at `transfers`, a **0-row** table, where every
counter is trivially zero and therefore says nothing.

Measured against a 505-row `customers` table:

| Sync | `cachedRecords` | `inserted` | `updated` | `deleted` | Change visible? |
|---|---|---|---|---|---|
| Initial | 707 | 505 | 202 | 0 | — |
| After one INSERT | **3** | **1** | 2 | 0 | yes |
| After one UPDATE | 2 | 0 | 2 | 0 | **yes** |
| After one DELETE | 2 | 0 | 2 | **0** | **yes** |

**Incremental is genuinely a delta sync** — 3 records processed against a 505-row table, not a quiet full
re-copy. And it reflects **updates and deletes**, not just inserts, which contradicts the reasonable
prior expectation that a watermark-based sync would miss deletions.

**But the counters are only partly trustworthy:**

- `numberOfInsertedRecords` is accurate — exactly `1` for one inserted row. Asserted.
- `numberOfUpdatedRecords` reports `2` on every incremental, whether or not anything changed. It appears
  to be fixed overhead rather than a count of the caller's changes.
- **`numberOfDeletedRecords` stays `0` while the sync demonstrably removes the row** — the cached count
  drops back to baseline and the row disappears from queries, in the very sync that reports zero
  deletions. The deletion counter does not reflect deletions.

The last one is reported by the test rather than asserted. Asserting `1` would assert a bug is fixed;
asserting `0` would institutionalise it. Anyone relying on these counters to drive alerting or
reconciliation should know only the insert count can be trusted.

`lastOffset` also stayed unchanged across all four syncs, which is worth knowing before treating it as a
progress watermark.

**Report upstream as:** an incremental cache update that deletes rows reports `numberOfDeletedRecords: 0`,
and `numberOfUpdatedRecords` appears to be a constant rather than a count.

---

## Corrected endpoint paths

Seven paths in `helpers/peakaClient.js` were once marked "best-effort / inferred from REST convention",
because `docs.peaka.com` blocked deep-fetching those individual pages. The full endpoint index at
[`docs.peaka.com/llms.txt`](https://docs.peaka.com/llms.txt) works where individual page fetches did
not — use it to verify a new endpoint.

That check found **three genuinely wrong paths**:

| Method | Was | Now |
|---|---|---|
| `triggerIncrementalUpdate` | `/cache/{id}/incremental` | `/cache/{id}/incrementalUpdate` |
| `triggerFullRefresh` | `/cache/{id}/full-refresh` | `/cache/{id}/fullRefreshUpdate` |
| `cancelFullRefresh` | `/cache/{id}/full-refresh/cancel` | `/cache/{id}/cancelFullRefreshUpdate` |

They had never failed visibly because no test called them at the time. The other four
(`getCatalog`, `deleteCache`, `deleteConnection`, `deleteCatalog`) turned out to be exactly right.

Verified against the live API rather than only the docs, by calling each with a syntactically valid but
non-existent `cacheId` so nothing real was refreshed or cancelled. The distinction is clear-cut: the
**old** paths return the generic framework "no route" `404` (byte-identical in shape to a deliberately
nonsense control path), while the **corrected** paths return real application-level handler errors that
actually looked the cache up.

A third docs-vs-behaviour divergence turned up in the process: for a non-existent cache,
`incrementalUpdate` and `fullRefreshUpdate` return **`400 WrongRequestException` "Cache settings not
found"**, not the documented `404`. (`cancelFullRefreshUpdate` does return a proper `404`.)

---

## Bugs in this test suite worth learning from

Two of these were more instructive than the product findings, because both produced **green tests that
proved nothing**.

### The execution records are two slots, not a fallback chain

Two helpers had independently written the same line:

```js
lastIncrementalCacheExecution || lastFullRefreshCacheExecution
```

Those are independent slots. Once an incremental update has run, its record stays populated **forever**,
so `||` returns it for the rest of the cache's life and every subsequent full refresh is invisible
behind it. Measured 1.5s into a full refresh:

| Field | Value |
|---|---|
| Top-level `status` | `RUNNING` |
| `lastIncrementalCacheExecution` | `COMPLETED` ← stale, from the previous incremental |
| `lastFullRefreshCacheExecution` | `RUNNING` ← the operation actually in flight |

So every "wait for the cache to finish" returned **on its first poll**, having read the wrong record.

**How it surfaced.** `M`'s full-refresh cancel step was rewritten to settle the cache first and then
assert an exact `404`. It returned `200`. The obvious reading — and the one first written into the
documentation — was that `cancelIncrementalUpdate` and `cancelFullRefresh` disagree about an idle cache.
They do not. The settle had returned instantly, so the cancel hit a refresh that was still running; a
real cancel really does return `200`. Both endpoints return `404` on a genuinely idle cache.

Both helpers now read the **most recent** record by `createdAt`, and "settled" additionally requires the
top-level status to be terminal — which closes the ~300ms after `triggerFullRefresh` where the new
record does not exist yet. The logic lives in `helpers/cacheExecution.js` so there is one copy to be
wrong, not two.

### A race test that passed without ever racing

The Tier 1 step that cancels a running materialized refresh reported `entered window: false,
status at fire: COMPLETED` on every run — it was silently testing the idle path the main suite already
covers. Cause: the status endpoint serves the *previous* terminal status until the new run starts, so
the poll gave up before the refresh had begun. It now ignores every status until
`lastExecutionStartTime` moves.

The broken and fixed versions both **passed**. The only difference was in the logged window telemetry,
which is why the canary step and the `entered window` logging exist at all.

### The common lesson

Both were exposed by pinning an assertion to a single expected value. While the cancel steps hedged on
`[200, 404]` they were green whichever answer came back, so a broken wait stayed invisible for as long
as the steps existed. **The hedge was not tolerating non-determinism — it was hiding a bug.**

---

## Race results

The deliberate concurrency tests (`npm run test:races`) and their per-tier outcome tables live in
[`CONCURRENCY-SPEC.md`](CONCURRENCY-SPEC.md), together with the reasoning for why they assert
invariants rather than expected values.
## 34. Every Google Ads table carries synthetic `_q_*` request-parameter columns alongside its real data

Found building the fourth connector folder (`tests/google-ads/`, project `uLgI0O4j`, catalog `gads`).
`listColumns` on `ad_group_criterion` (97 columns) and `keyword_stats_report` (32 columns) both include a
set of columns prefixed `_q_`: `_q_pagination_anchor`, `_q_customer_id`, `_q_limit`, `_q_offset`,
`_q_query`, `_q_search_settings`, `_q_validate_only`, `_q_page_size`, and (on report tables only)
`_q_segment_start_date`/`_q_segment_end_date`.

These are GAQL (Google Ads Query Language) *request* parameters — the knobs you'd set when asking Google
Ads for data — not response data. Selecting any of them returns `NULL` on every row, confirmed on both
tables. Every one of the 150+ tables in this catalog carries the same set, since GAQL itself works this way
underneath Peaka's SQL translation.

Not a bug — nothing is broken, and the `_q_` prefix does make them distinguishable from real columns by
convention. But `listColumns` does not flag them as anything other than ordinary columns (no `internal`
flag, no separate category), so a caller doing `SELECT *` or iterating `listColumns` naively gets eight-plus
always-null noise columns mixed into every result, with only the naming convention to tell them apart.
Reported, not asserted — GA-A logs the count found rather than asserting on it, since asserting an exact
count would tie the scenario to a Peaka/Google Ads schema detail rather than to anything worth a pass/fail.

## 35. The Google Ads connector is measurably flaky under repeated querying

Found while building GA-A. The *identical* query (`SELECT customer_id, clicks FROM keyword_stats_report
LIMIT 2`), repeated back-to-back against the same table with no changes, produced three different outcomes
across roughly 15 attempts made while probing this connector:

- **Most attempts**: `200`, correct data.
- **One attempt**: `200`, but `data: []` — a clean success envelope carrying zero rows, even though
  `COUNT(*)` on the same table simultaneously reported real rows present.
- **One attempt**: an outright `400`.

No pattern emerged across column selection, `ORDER BY` presence, `LIMIT` vs. no `LIMIT`, `OFFSET`, or which
table — every variant tried eventually both succeeded and failed on different attempts. This is the same
family of problem already on record for exports (*"exports fail intermittently in this API with no race
involved"*) — live-API flakiness, most plausibly on Google's own Ads API or Peaka's proxy layer to it,
rather than a deterministic bug in Peaka's SQL translation.

Not asserted as a defect, for the same reason exports aren't: a single failure proves nothing about a
specific input, only about that specific attempt. `tests/google-ads/fixture.js` builds retry tolerance into
every row-fetching helper (`withRetry`, 3 attempts, 2s apart, accepting the first non-empty result) rather
than trusting any single query — the same posture this suite already takes toward Stripe/internal-table
exports, extended to a connector where the *whole read path*, not just async jobs, turns out to need it.

## 36. Pagination over a low-cardinality Google Ads column silently returns overlapping pages

Found building `GA-F` (error handling & pagination). The scenario's first attempt ordered
`ad_group_criterion` by `ad_group_criterion_ad_group` — a foreign key to the owning ad group — and paged it
with `OFFSET 140 LIMIT 20` / `OFFSET 160 LIMIT 20`. The two pages **overlapped completely**: 20 of 20 rows
identical between them, despite non-overlapping offsets.

Measured why rather than assumed: `COUNT(DISTINCT ad_group_criterion_ad_group)` is **29** across the
table's 2,860 rows. `ORDER BY` over a column that coarse has enormous ties, and SQL never guarantees a
stable order among tied rows unless the query also sorts on something that breaks the tie — so which rows
land on which page becomes implementation-defined, and paging through it can revisit or skip rows
silently, with no error to signal it.

**Not a Peaka bug.** This is standard SQL behavior working exactly as specified — `ORDER BY` without a
unique tiebreaker never promised stable pagination, in Trino or anywhere else. It is, however, an easy trap
for anyone paginating Google Ads data through Peaka without realizing it: `ad_group_criterion` alone has
several low-cardinality columns that look plausible to sort by (`ad_group_criterion_status`,
`ad_group_criterion_type`, `ad_group_criterion_approval_status`) and would reproduce the same silent
overlap.

The fix, and what `GA-F` now orders by instead: Google Ads' own convention. Every resource type carries a
`resource_name` field Google documents as that resource's stable, globally unique identifier. Confirmed
live — `ad_group_criterion_resource_name` is 2,860-of-2,860 distinct — and a column with that property is
the only kind safe to paginate over without ties. Worth knowing before writing any query against this
connector that pages through results: prefer a `*_resource_name` column, or explicitly add one as a
tiebreaker, rather than the first plausible-looking column.

## 37. Creating a Google Ads catalog needs OAuth credentials even on an existing connection

Found while scoping `GA-G` (catalog endpoints). Postgres and MongoDB both let a scenario create a
throwaway catalog on an *existing* connection with nothing but `{ name, connectionId }` — no database
password, no connection string, just the id (see `tests/postgres/pg-g-catalogs.js`,
`tests/mongodb/mo-g-catalogs.js`). The same call against the Google Ads connection (`gads`,
`e068f1d2-1e6e-433f-abaa-1f3f87819570`) fails:

```
POST /catalogs { name: "...", connectionId: "e068f1d2-..." }
-> 400 {"errorCode":100,"message":"Fields [customerUnderscoreSecret, secret, token] are required for
type with serial name 'GOOGLE_ADS', but they were missing"}
```

Peaka wants the OAuth client secret and refresh token re-supplied at catalog-creation time, even though
the connection they belong to already exists and already works for every read this suite performs against
it (`GA-A`, `GA-C`, `GA-D`, `GA-F`, `GA-H` all query the *existing* catalog fine). Reusing a connection is
enough to query through it, but not enough to mint a new catalog on it — an asymmetry Postgres and MongoDB
don't have.

Practical consequence: `GA-G` is scoped down to the two assertions that don't need a throwaway catalog
(search, table statistics), and no `GA-I` (metadata refresh) or `GA-E` (connection lifecycle) exist at all
— both would need a throwaway catalog or a connection built from scratch, and both need the same OAuth
secret/token this suite was never given. Not a bug — an access-scoping decision on Peaka's part — but worth
recording so a future attempt to add those scenarios doesn't waste time assuming `connectionId` alone will
work here the way it does for Postgres and MongoDB.

## 38. `createCatalog` returns 500 for EVERY connection in some projects - the project decides, not the connection

Measured 2026-08-18 across two projects on the same API key, creating a throwaway catalog on a
connection that already had one, then deleting it:

| Project | Connection | `createCatalog` |
|---|---|---|
| `9LBuaGGX` | MongoDB | **500** |
| `9LBuaGGX` | Stripe | **500** |
| `z8mo8AxO` | MongoDB | 200 (deleted cleanly) |
| `z8mo8AxO` | Postgres | 200 (deleted cleanly) |

**This corrects an earlier conclusion in this repo.** `tests/hubspot/h-catalogs.js` recorded that Peaka
returns 500 when a second catalog is attached to a connection that already has one, reproduced across
H/L/M/N, and a helper implementing that approach was deleted as unworkable. That reproduction was real
but the attribution was wrong: every HubSpot run happened in `9LBuaGGX`, where the call fails for
*every* connection including Stripe's, and the Stripe scenarios that later succeeded with the same call
were running in `z8mo8AxO`. Two variables moved together and the wrong one got the blame - the lesson
being that "reproduced four times" is not the same as "isolated".

`9LBuaGGX` is also the project whose `listConnections` returns 403 for this key (finding 30), so the
likeliest explanation is a permission or plan boundary. **A 500 is the wrong status for that** - a
refusal the caller could act on is being reported as a server fault, with no message distinguishing it
from a genuine internal error. That is the part worth reporting to Peaka.

**Consequence for this suite:** any scenario that provisions its own catalog (MO-G, MO-I, the Stripe
H/L/M/N, the HubSpot equivalents) can run in one project and not the other, through no fault of the
connector or the data. It is not something the suite can work around - it fails loudly and says so.

## Server errors now have their own channel

Separate from a product finding: the instructor's spec states a firm rule (rule 6 of 8) — *a 5xx
response is always a bug, never an acceptable outcome, even in a negative scenario*. This suite had no way
to act on that. `helpers/assert.js` made no distinction between a `500` and a `400` at all, and **two
tests were already passing green while receiving a `500`**, with the only trace a `console.log` that
reached no report:

- `M`'s schema-wide cache-status step — the known bug in finding 7, tolerated with `[200, 500]`
- Tier 1's duplicate-`createCache`-mid-sync step — the known bug in finding 4, status logged, never
  asserted

Both are genuine Peaka bugs, already documented above, and outside this suite's control — making them
permanently fail would just train everyone to ignore red in this suite, which is how a real regression
would eventually hide. Both still pass. What changed is that every 5xx anywhere in the suite is now
recorded with its scenario, step, and (where tolerated) the rationale, surfaced in a terminal banner, in
`test-results/coverage.json`, and in the dashboard as a distinct state — visually separate from both a
clean pass and a failure. See `helpers/serverError.js`.

## Verified working: cache refresh does pick up source changes

Not a bug — a question that had never been answered, and worth recording because the answer was genuinely
uncertain before it was measured. `M` proves the refresh endpoints *respond* correctly, but a refresh that
returned `200` and silently fetched nothing new would have passed every assertion in it.

Scenario `O` adds a real customer to Stripe and watches what the cache does. Measured 2026-08-03:

| Step | Result |
|---|---|
| Before any refresh | The new customer is **not** visible — confirming the query reads the cached snapshot, without which the rest proves nothing |
| After `triggerIncrementalUpdate` | **Visible.** Incremental sync *does* detect inserts — the open question going in |
| Row count | Rose by exactly one, so the refresh reconciles rather than duplicating |
| After deleting upstream + full refresh | Removal reflected, count back to baseline |

Both directions work. The scenario still tries incremental first and falls back to a full refresh, and
reports which one succeeded rather than asserting it — if a future connector version stops detecting
inserts incrementally, that surfaces as a logged difference rather than a red test, and this table is
what it should be compared against.

### Incremental really is incremental — and it handles all three change types

Extended 2026-08-04 to cover updates and deletes, and to read the `progress` counters, which nothing had
ever done with real data. The only previous look was at `transfers`, a **0-row** table, where every
counter is trivially zero and therefore says nothing.

Measured against a 505-row `customers` table:

| Sync | `cachedRecords` | `inserted` | `updated` | `deleted` | Change visible? |
|---|---|---|---|---|---|
| Initial | 707 | 505 | 202 | 0 | — |
| After one INSERT | **3** | **1** | 2 | 0 | yes |
| After one UPDATE | 2 | 0 | 2 | 0 | **yes** |
| After one DELETE | 2 | 0 | 2 | **0** | **yes** |

**Incremental is genuinely a delta sync** — 3 records processed against a 505-row table, not a quiet full
re-copy. And it reflects **updates and deletes**, not just inserts, which contradicts the reasonable
prior expectation that a watermark-based sync would miss deletions.

**But the counters are only partly trustworthy:**

- `numberOfInsertedRecords` is accurate — exactly `1` for one inserted row. Asserted.
- `numberOfUpdatedRecords` reports `2` on every incremental, whether or not anything changed. It appears
  to be fixed overhead rather than a count of the caller's changes.
- **`numberOfDeletedRecords` stays `0` while the sync demonstrably removes the row** — the cached count
  drops back to baseline and the row disappears from queries, in the very sync that reports zero
  deletions. The deletion counter does not reflect deletions.

The last one is reported by the test rather than asserted. Asserting `1` would assert a bug is fixed;
asserting `0` would institutionalise it. Anyone relying on these counters to drive alerting or
reconciliation should know only the insert count can be trusted.

`lastOffset` also stayed unchanged across all four syncs, which is worth knowing before treating it as a
progress watermark.

**Report upstream as:** an incremental cache update that deletes rows reports `numberOfDeletedRecords: 0`,
and `numberOfUpdatedRecords` appears to be a constant rather than a count.

---

## Corrected endpoint paths

Seven paths in `helpers/peakaClient.js` were once marked "best-effort / inferred from REST convention",
because `docs.peaka.com` blocked deep-fetching those individual pages. The full endpoint index at
[`docs.peaka.com/llms.txt`](https://docs.peaka.com/llms.txt) works where individual page fetches did
not — use it to verify a new endpoint.

That check found **three genuinely wrong paths**:

| Method | Was | Now |
|---|---|---|
| `triggerIncrementalUpdate` | `/cache/{id}/incremental` | `/cache/{id}/incrementalUpdate` |
| `triggerFullRefresh` | `/cache/{id}/full-refresh` | `/cache/{id}/fullRefreshUpdate` |
| `cancelFullRefresh` | `/cache/{id}/full-refresh/cancel` | `/cache/{id}/cancelFullRefreshUpdate` |

They had never failed visibly because no test called them at the time. The other four
(`getCatalog`, `deleteCache`, `deleteConnection`, `deleteCatalog`) turned out to be exactly right.

Verified against the live API rather than only the docs, by calling each with a syntactically valid but
non-existent `cacheId` so nothing real was refreshed or cancelled. The distinction is clear-cut: the
**old** paths return the generic framework "no route" `404` (byte-identical in shape to a deliberately
nonsense control path), while the **corrected** paths return real application-level handler errors that
actually looked the cache up.

A third docs-vs-behaviour divergence turned up in the process: for a non-existent cache,
`incrementalUpdate` and `fullRefreshUpdate` return **`400 WrongRequestException` "Cache settings not
found"**, not the documented `404`. (`cancelFullRefreshUpdate` does return a proper `404`.)

---

## Bugs in this test suite worth learning from

Two of these were more instructive than the product findings, because both produced **green tests that
proved nothing**.

### The execution records are two slots, not a fallback chain

Two helpers had independently written the same line:

```js
lastIncrementalCacheExecution || lastFullRefreshCacheExecution
```

Those are independent slots. Once an incremental update has run, its record stays populated **forever**,
so `||` returns it for the rest of the cache's life and every subsequent full refresh is invisible
behind it. Measured 1.5s into a full refresh:

| Field | Value |
|---|---|
| Top-level `status` | `RUNNING` |
| `lastIncrementalCacheExecution` | `COMPLETED` ← stale, from the previous incremental |
| `lastFullRefreshCacheExecution` | `RUNNING` ← the operation actually in flight |

So every "wait for the cache to finish" returned **on its first poll**, having read the wrong record.

**How it surfaced.** `M`'s full-refresh cancel step was rewritten to settle the cache first and then
assert an exact `404`. It returned `200`. The obvious reading — and the one first written into the
documentation — was that `cancelIncrementalUpdate` and `cancelFullRefresh` disagree about an idle cache.
They do not. The settle had returned instantly, so the cancel hit a refresh that was still running; a
real cancel really does return `200`. Both endpoints return `404` on a genuinely idle cache.

Both helpers now read the **most recent** record by `createdAt`, and "settled" additionally requires the
top-level status to be terminal — which closes the ~300ms after `triggerFullRefresh` where the new
record does not exist yet. The logic lives in `helpers/cacheExecution.js` so there is one copy to be
wrong, not two.

### A race test that passed without ever racing

The Tier 1 step that cancels a running materialized refresh reported `entered window: false,
status at fire: COMPLETED` on every run — it was silently testing the idle path the main suite already
covers. Cause: the status endpoint serves the *previous* terminal status until the new run starts, so
the poll gave up before the refresh had begun. It now ignores every status until
`lastExecutionStartTime` moves.

The broken and fixed versions both **passed**. The only difference was in the logged window telemetry,
which is why the canary step and the `entered window` logging exist at all.

### The common lesson

Both were exposed by pinning an assertion to a single expected value. While the cancel steps hedged on
`[200, 404]` they were green whichever answer came back, so a broken wait stayed invisible for as long
as the steps existed. **The hedge was not tolerating non-determinism — it was hiding a bug.**

---

## Race results

The deliberate concurrency tests (`npm run test:races`) and their per-tier outcome tables live in
[`CONCURRENCY-SPEC.md`](CONCURRENCY-SPEC.md), together with the reasoning for why they assert
invariants rather than expected values.
