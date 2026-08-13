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
| 8 | Eleven smaller quirks that break naive clients, several contradicting the reference | Low | Open, documented |
| 9 | **`SqlExec` cannot write at all** — INSERT/UPDATE/DELETE/CTAS all `400` | **High** | Open — the instructor's spec assumes DML through this endpoint; it does not exist |
| 10 | **CSV import silently accepts a mapping to a nonexistent column and writes `NULL`** | **High** | Open, asserted as a pinned deviation |
| 11 | **No row-level UPDATE/DELETE endpoint exists anywhere** for internal tables | **High** | Open, asserted as a capability gap |
| 12 | **BI Table's `displayName` is never respected**, at creation or update, across all 8 column types — the update endpoint's response actively lies about it | Medium | Open, asserted as a pinned deviation |
| 13 | **BI Table names collide after underscore-stripping** — two different requested names silently write to the same table | Medium | Open, asserted |
| 14 | JSON columns are rejected for **both** internal table kinds, contradicting the spec's own claim that Peaka Table supports them | Medium | Open |
| 15 | `getTableSample` returns a canned template unrelated to the real table, before or after real data exists | Low | Open |
| 16 | Trino requires `OFFSET` before `LIMIT`; the reverse order (valid Postgres/MySQL) is a syntax error | Low | Documented, worth knowing when porting SQL |

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
(`PT-12`). Measured directly: three of its four "make the import fail" cases do fail cleanly. The fourth
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

Asserted in `PT-12` as the real, measured behaviour — not the spec's assumption — so if Peaka ever starts
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
`PT-08: point-edit UPDATE/DELETE (capability gap)` — not a feature test, a pinned absence: it asserts the
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

Asserted in `BT-06`, deliberately inverted from what `PT-04` checks for Peaka Table: it asserts the
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
like `"has_underscore"` round-trips through CSV import unchanged), but BI Table has no write path at all
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
documentation, not a spec typo. It blocks `PT-03` and `PT-10` (both of which include a JSON column) as
literally written, for both table types. The error message itself is a secondary quality issue worth
separate note: it leaks an internal Java class name (`com.peaka.gateway.model.ColumnRequest.ColumnType`)
directly to the API consumer.

## 15. `getTableSample` returns a canned template, not real data

The spec expects `PT-13` to return the table's real column names as a CSV header. Measured with a
raw-text fetch (the JSON-only response parser in this repo's client cannot even read a `text/csv`
response, which is itself worth knowing):

| Table state | Response |
|---|---|
| Table doesn't exist | `200`, body is five blank lines |
| Real table, declared columns `name`/`age`, zero rows | `200`, header is `text,name,age` — `text` was never declared — rows are `"sample text","sample text",<random int>` |
| Same table, **after** importing real rows (`alice`/30, `bob`/40) | `200`, identical synthetic pattern — real data never appears |

In every observed case the response is disconnected from both the table's real schema and its real
content — it looks like a fixed example generator, unaffected by anything varied in the test. `PT-13`'s
expectation that this reflects the real table does not hold as measured.

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
