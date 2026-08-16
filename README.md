# Peaka Partner API Test Suite

An end-to-end Jest suite that validates the [Peaka Partner API](https://docs.peaka.com/api-reference/introduction)
against five things: a live Stripe connector, a live HubSpot connector, a live Postgres (Supabase)
connector, a live MongoDB connector, and Peaka's own built-in Peaka Table / BI Table feature.

Peaka is a data-integration platform: you connect a source, it exposes the source's tables through a SQL
interface, and — for API connectors — it can *cache* those tables locally for faster reads. This suite
checks that the whole chain works, and running the same questions against more than one connector is what
turns an observation ("Peaka does X") into an attribution ("Peaka's *Stripe connector* does X, but not its
Postgres connector") — see [What it found](#what-it-found) below.

**There are no mocks.** Every test talks to a live Peaka project and live sandbox accounts (Stripe test
mode, a HubSpot test account, ...). That is the point: the failures worth finding are in the real API's
behaviour, not in a stub of it. It also means runs take real time, need credentials, and create and
delete real resources.

**HubSpot's tests are newer and less battle-tested than Stripe's or Postgres's.** HubSpot connections in
Peaka are **OAuth2** (confirmed via `getConnectionConfig("hubspot")` - credential fields
`accessToken`/`refreshToken`/`clientId`/`clientSecret`/`redirectUrl`), unlike Stripe's simple `sk_test_...`
secret key, so `HUBSPOT_ACCESS_TOKEN` (see below) is a different kind of credential to obtain - likely a
HubSpot **Private App token**, though that hasn't been confirmed accepted by Peaka yet. Most HubSpot
scenarios (`B`/`C`/`F`/`I`/`J`/`K`) only ever read the pre-existing catalog and don't need it at all - only
`G`/`H`/`L`/`M`/`N` (which provision their own connection) do, so a clone without a HubSpot account still
runs most of the folder. See `tests/hubspot/config.js` and `tests/hubspot/checkTokenCredentials.js`.

**Tried and rejected: giving `H`/`L`/`M`/`N` a token-free path by attaching their isolated catalog to the
already-working connection behind the shared `PEAKA_HUBSPOT_CATALOG_ID`**, instead of creating a new
connection. `createCatalog()` accepts any `connectionId` in principle, so this looked promising - but Peaka
returned a real `500 Internal Server Error` every time, reproduced consistently across all four scenarios.
Whatever the exact constraint is, Peaka does not support attaching a second catalog to a connection that
already has one - confirmed against the live API, not assumed. So `G`, `H`, `L`, `M`, `N` all genuinely need
their own connection, token and all.

## What it found

Testing against the real API surfaced several genuine product bugs, and — via a second and third
connector — settled which platform claims were connector-specific rather than Peaka-wide. Full write-ups,
with evidence and reproduction steps, are in **[FINDINGS.md](FINDINGS.md)**.

| Finding | Severity |
|---|---|
| Live (uncached) Stripe queries silently return at most **100 rows** — any query, not just `COUNT(*)` | **High** |
| That cap is **connector-specific**, proven four independent ways against Postgres (queries, exports, materialization, saved queries) | **High** |
| `SqlExec` cannot write at all — the instructor's Peaka Table spec assumes DML through it, and it does not exist | **High** |
| CSV import silently accepts a mapping to a nonexistent column and writes `NULL` instead of rejecting it | **High** |
| No row-level UPDATE/DELETE endpoint exists anywhere for internal tables — SQL or REST | **High** |
| Deleting a cache can leave a table **permanently unreachable** through Peaka | **High** |
| BI Table's `displayName` is never respected, and the update endpoint's response actively lies about it | Medium |
| Duplicate `createCache` during an in-progress sync returns `500`, not the documented `409` | Medium |

FINDINGS.md also documents bugs found in *this suite itself* — including two tests that were passing
green while receiving a `500`, and two that produced green results proving nothing — worth reading before
adding assertions of your own.

## Prerequisites

**Required for any run:**

- **Node.js ≥ 18** (uses the built-in `fetch`)
- A **Peaka** project and a Partner API key

That alone runs the `peaka-tables` folder, which creates and seeds everything it asserts against.

**Optional — each unlocks more scenarios:**

| To run | You need |
|---|---|
| The Stripe folder | A Peaka Stripe connection + catalog, and a Stripe **test** account with data |
| The HubSpot folder | A Peaka HubSpot connection + catalog (scoped to the `crm` schema); `HUBSPOT_ACCESS_TOKEN` unlocks the rest (`G`/`H`/`L`/`M`/`N`) |
| The Postgres folder | A Peaka Postgres connection + catalog with at least one table of >100 rows |
| The MongoDB folder | A Peaka MongoDB connection + catalog with at least one collection of >100 rows |

**No numbers to configure.** Expected values are measured at runtime — the customer count comes
from Stripe's own API, and the Postgres/MongoDB fixture (which table, how many rows, which column to
filter on) is discovered from the catalog. Nothing needs tuning to match your data.

**Missing data skips rather than fails.** A run measures the environment first, skips the
scenarios whose data is absent, and exits **non-zero** with a list of what did not execute — so a
partial run can never be mistaken for a full pass. See [Incomplete runs](#incomplete-runs).

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
PEAKA_API_KEY=your_peaka_partner_api_key
PEAKA_PROJECT_ID=your_peaka_project_id

# Stripe folder (omit to skip those scenarios)
STRIPE_TEST_TOKEN=sk_test_your_stripe_test_key
PEAKA_CATALOG_ID=your_existing_peaka_catalog_id
PEAKA_CATALOG_NAME=stripe
PEAKA_SCHEMA_NAME=payment

# Postgres folder (omit to skip those scenarios)
PEAKA_PG_CATALOG_ID=your_postgres_catalog_id
PEAKA_PG_SCHEMA_NAME=public
PEAKA_PG_CONNECTION_ID=your_postgres_connection_id

# MongoDB folder (omit to skip those scenarios)
PEAKA_MONGO_CATALOG_ID=your_mongo_catalog_id
PEAKA_MONGO_SCHEMA_NAME=your_mongo_database_name
PEAKA_MONGO_CONNECTION_ID=your_mongo_connection_id

# Google Ads folder (omit to skip those scenarios). The ONLY connector in a
# separate Peaka project, so it carries its own key/project pair - see
# tests/google-ads/config.js's apiKeyEnv/projectIdEnv.
PEAKA_API_KEY_ADS=your_google_ads_project_api_key
PEAKA_PROJECT_ID_ADS=your_google_ads_project_id
PEAKA_GOOGLE_ADS_CATALOG_ID=your_google_ads_catalog_id
PEAKA_GOOGLE_ADS_CATALOG_NAME=gads
PEAKA_GOOGLE_ADS_SCHEMA_NAME=public

EXPECTED_CUSTOMER_COUNT_NON_CACHE=100

# HubSpot folder (omit to skip those scenarios; OAuth2, see the table below)
HUBSPOT_ACCESS_TOKEN=your_hubspot_access_token
PEAKA_HUBSPOT_CATALOG_ID=your_existing_hubspot_catalog_id
PEAKA_HUBSPOT_CATALOG_NAME=hubspot
PEAKA_HUBSPOT_SCHEMA_NAME=crm
```

Each connector's credentials are independent - set only Stripe's, only HubSpot's, or both. A connector
with missing/placeholder credentials has its scenarios reported as **skipped** (not failed) by both
`npm test` and the dashboard; the other connector runs normally.

| Variable | Where it comes from |
|---|---|
| `PEAKA_API_KEY` | Peaka Studio → Developer ([guide](https://docs.peaka.com/how-to-guides/how-to-manage-partner-api-key)) |
| `PEAKA_PROJECT_ID` | Your project's URL or settings in Peaka Studio |
| `STRIPE_TEST_TOKEN` | A Stripe **test** secret key (`sk_test_…`). The suite refuses to run against a live key |
| `PEAKA_CATALOG_ID` | An existing Stripe catalog, created alongside its connection in Studio. `B` reads this catalog rather than creating one |
| `PEAKA_CATALOG_NAME` | The catalog's SQL-queryable name. Used as a fallback if the live lookup fails |
| `PEAKA_SCHEMA_NAME` | The Stripe connector's schema, e.g. `payment`. `B` cross-checks it against a live `listSchemas` |
| `HUBSPOT_ACCESS_TOKEN` | A HubSpot **access token**. Confirmed via `getConnectionConfig("hubspot")` that Peaka's HubSpot connections are OAuth2 (fields: `accessToken`/`refreshToken`/`clientId`/`clientSecret`/`redirectUrl`) — a HubSpot **Private App token** is the most likely candidate value here but hasn't yet been confirmed accepted by Peaka. Only needed by `G`/`H`/`L`/`M`/`N` (the scenarios that provision their own connection) - `B`/`C`/`F`/`I`/`J`/`K` never read it |
| `PEAKA_HUBSPOT_CATALOG_ID` | An existing HubSpot catalog, created alongside its connection in Studio. `B` reads this catalog rather than creating one |
| `PEAKA_HUBSPOT_CATALOG_NAME` | The HubSpot catalog's SQL-queryable name. Used as a fallback if the live lookup fails |
| `PEAKA_HUBSPOT_SCHEMA_NAME` | The HubSpot connector's schema holding the core CRM objects, e.g. `crm` (HubSpot also exposes `conversations`, `crm_associations`, `scheduler`, `settings` — out of scope for this suite) |
| `PEAKA_PG_CATALOG_ID` | An existing Postgres catalog. The folder reuses it rather than creating one — no database password is ever stored |
| `PEAKA_PG_SCHEMA_NAME` | The schema to test, e.g. `public` |
| `PEAKA_PG_CONNECTION_ID` | The connection behind that catalog. An id, not a secret |
| `PEAKA_PG_TABLE` | *Optional.* Pins a specific table instead of letting the preflight pick the largest one |
| `PEAKA_MONGO_CATALOG_ID` | An existing MongoDB catalog. The folder reuses it rather than creating one — no connection string is ever stored |
| `PEAKA_MONGO_SCHEMA_NAME` | The Mongo *database* to test — Peaka reports each Mongo database as one "schema", e.g. `e_commerce` |
| `PEAKA_MONGO_CONNECTION_ID` | The connection behind that catalog. An id, not a secret |
| `PEAKA_API_KEY_ADS` / `PEAKA_PROJECT_ID_ADS` | Google Ads lives in a **different Peaka project** with its own key. Only the CLI needs these — the dashboard reaches that project by connecting with its key and picking it in the project grid |
| `PEAKA_GOOGLE_ADS_CATALOG_ID` / `PEAKA_GOOGLE_ADS_SCHEMA_NAME` | An existing Google Ads catalog and its schema (`public`). The folder reuses the connection — creating one needs real OAuth credentials this suite doesn't hold |
| `EXPECTED_CUSTOMER_COUNT_NON_CACHE` | The known live-query cap (`100`). A **product constant**, not your data — a deliberate regression test, see [FINDINGS.md](FINDINGS.md#1-live-queries-cannot-return-more-than-100-rows) before changing it |
| `ALLOW_INCOMPLETE` | Set to `true` to exit 0 despite skipped scenarios. See [Incomplete runs](#incomplete-runs) |
| `FAIL_ON_SERVER_ERROR` | Set to `true` to exit non-zero if any 5xx was observed, even a tolerated one. See [Server errors](#server-errors) |

> ⚠️ `.env` holds real credentials and is git-ignored. Do not commit it.

## Running

```bash
npm test                 # the main suite, ~85s
npm run test:races       # the concurrency suite, ~10 min (see below)
npm run web              # browser dashboard at http://localhost:3000
npm run check:refs       # traceability check, no API calls, instant
```

### Traceability — which rule made each test necessary

Every Peaka Tables scenario carries a `refs` array in its `meta.js` entry, linking it to the written
rule it exists to enforce: an official docs page, a scenario in the instructor's spec, or a
[FINDINGS.md](FINDINGS.md) entry. The idea is borrowed from the [Open Banking conformance
suite](https://github.com/OpenBankingUK/conformance-suite), where each test case carries a `refURI`
pointing at the spec clause it tests.

`npm run check:refs` validates those links and prints two tables worth having:

- **Spec coverage** — which of the spec's scenario ids are claimed by a test, so *"what do you actually
  cover?"* is answered by a script rather than by hand.
- **Findings cited by no scenario** — informational, since many findings are Stripe- or Postgres-only.

It **exits non-zero** when a scenario cites a finding number that has no matching `## <n>.` heading, which
is how a renumbered finding gets caught instead of silently dangling.

### Incomplete runs

Before any test loads, a **preflight** measures what data actually exists (`jest.globalSetup.js` →
`helpers/preflight.js`). Scenarios whose data is absent are skipped rather than run against an
empty catalog, because the alternative — failing deep inside a scenario after creating four
caches — reads like a product bug when it is really a setup gap.

Skipping is safe only if it can never be confused with passing, so a partial run:

- reports each skip as a real Jest `test.skip`, counted separately from passes
- prints a banner naming every scenario that did not execute, and why
- writes `test-results/coverage.json` — ran/skipped per scenario, machine-readable
- **exits non-zero**, so CI and `npm test && …` cannot treat it as a full pass

```
════════════════════════════════════════════════════════
  INCOMPLETE RUN — 3 of 20 scenarios did not execute
════════════════════════════════════════════════════════
  C: Data Correctness    Stripe catalog has 0 customers
  K: Export Endpoints    Stripe catalog has 0 charges
  PG-B: Data Correctness no table in 'public' exceeds 100 rows
  These scenarios verified NOTHING. Coverage was reduced.
════════════════════════════════════════════════════════
```

Set `ALLOW_INCOMPLETE=true` to accept the gap and exit 0 — deliberately a conscious choice rather
than the default.

**A broken API is never mistaken for missing data.** The preflight distinguishes a query that
*succeeds and returns zero rows* (→ skip) from one that *fails* (→ the run aborts). Without that
split, an outage would skip everything and look tidy — which is exactly the failure this design
exists to prevent, and which [FINDINGS.md](FINDINGS.md) records happening once already.

### Server errors

The instructor's spec is explicit: a `5xx` is always a bug, never an acceptable outcome, even in a
negative scenario. Two tests in this suite pass while tolerating a known, documented Peaka `500` — see
[FINDINGS.md](FINDINGS.md#server-errors-now-have-their-own-channel) — because the bugs are Peaka's and
outside this suite's control, and a permanently-red test for someone else's bug gets ignored, which is
how real regressions hide.

They still pass, but a `5xx` anywhere can no longer pass *silently*:

```
════════════════════════════════════════════════════════════════════════
  SERVER ERRORS — 1 5xx response across 27 scenarios
════════════════════════════════════════════════════════════════════════
  M: Cache Management Endpoints   [PASSED]
    schema-wide cache statuses (known 500)
      500  getAllCacheStatusesOfSchema
      KNOWN: the schema-level variant returns 500 while the project- and catalog-level ones work...
════════════════════════════════════════════════════════════════════════
```

Every `5xx` is recorded to `test-results/coverage.json` and shown in the dashboard as its own magenta
state — distinct from both a pass and a fail, since "passed but the server errored" is neither. The
default exit code is unaffected; set `FAIL_ON_SERVER_ERROR=true` to enforce the spec's rule literally.

Sample output:

```
PASS jest/stripe/j-internal-tables.test.js    ✓ J: Internal Table Endpoints (3651 ms)
PASS jest/stripe/h-catalogs.test.js           ✓ H: Catalog Endpoints (4409 ms)
PASS jest/stripe/g-connections.test.js        ✓ G: Connection Endpoints (5882 ms)
PASS jest/stripe/k-exports.test.js            ✓ K: Export Endpoints (7307 ms)
PASS jest/stripe/i-queries.test.js            ✓ I: Saved Query Endpoints (7734 ms)
PASS jest/stripe/n-materialized-queries.test.js ✓ N: Materialized Query Endpoints (13653 ms)
PASS jest/stripe/l-metadata.test.js           ✓ L: Metadata Refresh Endpoints (17677 ms)
PASS jest/stripe/m-cache-management.test.js   ✓ M: Cache Management Endpoints (34459 ms)
PASS jest/stripe/connector.test.js
  ✓ B: Catalog & Schema Discovery (5077 ms)
  ✓ C: Data Correctness & Cache Behavior (62927 ms)
  ✓ F: Error Handling & Edge Cases (4189 ms)

Test Suites: 9 passed, 9 total
Tests:       11 passed, 11 total
```

Run one scenario on its own with `npx jest -t "M: Cache Management Endpoints"`.

Resources created during a run are deleted automatically in `afterAll`. To leave them for inspection:

```bash
SKIP_CLEANUP=true npm test
```

### The concurrency suite

`npm run test:races` is a **separate** suite that deliberately manufactures conflicts — cancelling a
sync mid-flight, creating a duplicate cache while the first is still running, querying a table as it is
being cached. It has its own config (`jest.races.config.js`), runs single-threaded, and is excluded from
`npm test`. See [CONCURRENCY-SPEC.md](CONCURRENCY-SPEC.md) for the design and results.

> ⚠️ **Never run the two suites at the same time.** Both drive real Jest runs against the same Peaka
> project and the same tables. Overlapping them creates *unintended* races on top of the intended ones,
> and the result looks exactly like a code regression. A preflight check refuses to start the races if
> it detects another run.

### The web dashboard

`npm run web` serves a browser UI at **http://localhost:3000** that runs the same Jest suites and streams
results live. It is not an alternative implementation — a run is a real `jest` process (`jest/runInChild.js`
calls Jest's own programmatic API, `runCLI`), forked from `server.js` rather than called in-process, so
what you see is a real Jest run — and, unlike an in-process call, one the dashboard can actually kill (see
**Stopping a run** below).

**It's a real app now, not a single screen — and it no longer needs `.env` at all to get started.** The
home page is a **Connect** screen: paste a Peaka Partner API key and the dashboard walks Peaka's own API
to figure out what it can see, live:

1. **Connect** — paste a Partner API key. The dashboard tries to list every project it can see
   (`GET /organizations` → workspaces → projects). Two real key shapes exist, and the dashboard handles
   both (confirmed against the live API, not assumed):
   - An **account-wide key** can list organizations/workspaces/projects directly → you land on a project
     grid.
   - A **project-scoped key** gets a `403 Forbidden` on that same call (confirmed: the *identical* key
     still works fine for that one project's own connections/catalogs/etc — it's scoped, not invalid) →
     the dashboard asks for that project's ID once, then continues.
   The key is kept in memory for the server process only — never written to `.env`, never sent anywhere
   but Peaka. **"Use a different key"** clears the session and returns to this screen.
2. **Project** — that project's actual connectors, listed from its **catalogs** (`listCatalogs`), not
   `listConnections` — confirmed the two can disagree (a project can have a fully working Stripe/HubSpot
   catalog while `listConnections` reports none at all). Only connectors this repo has a `tests/<type>/`
   folder for are clickable; the rest (MongoDB, Postgres, Pinecone, ...) show disabled ("no test suite
   yet").
3. **Runner** — the existing scenario list / results / detail panes, now scoped to the exact project +
   connection you picked. Select scenarios, click **Run Selected**, watch each step report itself live.

Picking a project+connection resolves its catalog and schema live and overwrites the connector's env vars
for that run only — `.env`'s `PEAKA_API_KEY`/`PEAKA_PROJECT_ID`/`PEAKA_CATALOG_ID`/`PEAKA_SCHEMA_NAME`
(and the HubSpot equivalents) become **optional**: if present, they just pre-fill the Connect screen's
session on server start (convenient for solo/local use), but nothing requires them anymore for the
dashboard specifically — `npm test` (the CLI path) is the one thing still reading them directly. Third-
party credentials (`STRIPE_TEST_TOKEN`, `HUBSPOT_ACCESS_TOKEN`) still come from `.env` regardless of which
project is picked — Peaka never returns a connection's real credential (it's masked), so there's no way to
fetch these dynamically; they're only actually needed by the scenarios that create a **new** Peaka
connection (`G`/`H`/`L`/`M`/`N` and the races) rather than read a pre-existing catalog. See
`helpers/peakaAccount.js` for the discovery/resolution logic and `server.js`'s `session`/`classifyApiKey`
for the connect flow.

Credentials never reach the browser via `.env` — but note the Connect screen is a deliberate exception:
you type the Partner API key into it yourself, so it does live in the browser tab for that session (same
tradeoff any "paste your API key" tool makes). It is never persisted to disk — nothing is written to
`.env`, no `console.log` of it exists anywhere in the code, and the browser side never puts it in
`localStorage`/`sessionStorage`/a cookie either. **"Sign out"** (reachable from every screen's top bar,
not just the home page) clears it from the server's memory immediately; restarting the server does the
same. See `server.js`'s `session` object and `classifyApiKey()`.

### Running several connectors at once

The project screen lists every connector in the project. **Tick as many as you like and click "Run
selected"** — they run *concurrently*, each in its own forked process, each with its own live progress on
its card. Click any card while it runs to watch that connector's scenarios stream in; go back and click
another to watch its. Results persist, so clicking in after a batch shows the real per-step detail rather
than an empty runner.

**The race folders are the exception.** `Concurrency Races` (and `HubSpot Races`) measure behaviour under
deliberately manufactured concurrent load, so a sibling run hammering the same project is exactly the
contamination they exist to observe. They stay mutually exclusive with everything: ticking one greys out
every other connector, and vice versa. They appear indented beneath the connector they exercise, since
they are a *mode* of testing it rather than a separate connection. `server.js`'s `canStart()` enforces
this server-side too — the UI only mirrors it so the rule is visible before you click rather than
arriving as a `409` after.

**Stop all** stops everything in flight; a single connector's own **Stop** (in its runner) stops only
that one and leaves its siblings running.

Reloading the page mid-run does **not** resume: `server.js` kills a run when its `EventSource`
disconnects, deliberately, so an unwatched run stops burning real API calls.

### Stopping a run

A run can be genuinely stopped mid-flight — click **Stop** (appears next to **Run All** while a run is in
progress). This works because each run is a real, separate OS process (`jest/runInChild.js`, forked by
`server.js`), not Jest called in-process — `server.js` can `child.kill()` it, which an in-process `runCLI()`
call has no equivalent for. The stopped scenario shows a distinct **"Stopped"** state (not pass/fail/skip).

**Killing the process means Jest's `afterAll()` cleanup never runs.** Any real Peaka resources (connections,
catalogs, caches) the stopped scenario had already created before you clicked Stop are **not** automatically
deleted — the dashboard says so plainly when this happens. Check Peaka Studio if you stop a scenario that
creates its own connection/catalog (`G`/`H`/`L`/`M`/`N`, the races).

### A note on the dashboard's security posture

The dashboard now holds a live Partner API key in memory for as long as the server runs, which is worth
being deliberate about, not just trusting "it's localhost":

- **Binds to `127.0.0.1` only**, not all network interfaces — Node's default (no host given) listens on
  every interface, which would let anyone else on the same Wi-Fi/LAN reach your running dashboard and
  whatever session is connected. Confirmed this was the actual default before it was pinned down explicitly.
- **Rejects cross-origin requests** to every `/api/*` route (a same-origin check on the `Origin`/`Referer`
  header) — without this, any other website you happened to have open in another tab could silently POST to
  `localhost:3000/api/...` and use your active session (trigger a real run, change the connected project,
  etc.), since browsers don't block a cross-origin request from being *sent*, only from having its response
  *read*. See `server.js`'s `requireSameOrigin`.
- Sends `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and
  `Referrer-Policy: no-referrer` on every response.
- This is still a **local, single-user tool** — the in-memory session is one shared global, not
  per-browser-tab/cookie. Two people should not point their browsers at the same running server at once;
  each person runs their own `npm run web` and connects with their own key.

## What each scenario covers

Table below is written from the Stripe suite; HubSpot's `tests/hubspot/*.js` mirror the same scenario
letters and step shapes against `contacts`/`companies`/`deals` in the `crm` schema — see each HubSpot file's
header comment for where it deliberately asserts less than its Stripe counterpart (no assumed live-query
cap, no assumed table-statistics limitation, etc.) pending real measurement.

| Scenario | Covers |
|---|---|
| **B: Catalog & Schema Discovery** | Reading the configured catalog, discovering its schema and core tables, verifying cache-capability flags and expected columns |
| **C: Data Correctness & Cache Behavior** | Every count and distribution assertion run **twice** — once uncached, once served from cache — with the full cache lifecycle in between, plus non-cacheable rejection and duplicate-creation handling |
| **F: Error Handling & Edge Cases** | Querying a non-existent table; pagination correctness across pages |
| **G: Connection Endpoints** | Connection CRUD, invalid-token handling, the connector-config catalogue, and a **credential-masking check** asserting the Stripe key is never echoed back |
| **H: Catalog Endpoints** | Catalog create/list/delete, project-wide search, table statistics |
| **I: Saved Query Endpoints** | Saved-query CRUD and SQL transpilation |
| **J: Internal Table Endpoints** | Peaka internal table and column CRUD |
| **K: Export Endpoints** | Async CSV export: start → poll to `SUCCEEDED` → read → list → cancel |
| **L: Metadata Refresh Endpoints** | Trigger a metadata refresh and poll it to a terminal state |
| **M: Cache Management Endpoints** | Cache settings, batch creation, all three all-statuses variants, execution history, trigger/cancel for incremental and full refresh |
| **N: Materialized Query Endpoints** | Create, poll, list, refresh, cancel, recovery, and the `inputQueryRefId` variant |
| **O: Data Freshness** | Adds a customer **in Stripe**, proves it isn't visible in the cache, refreshes, and proves it is — then deletes it and checks the removal is reflected too |

### 🐘 Postgres — a second connector

`tests/postgres/` exists to answer a question the Stripe scenarios cannot: **which findings belong to
Peaka, and which belong to Peaka's Stripe connector?** It mirrors Stripe's B/C/F/G/H/I/K/L/N one-for-one —
everything except `M`, `O`, and the race tiers, which need caching and databases cannot be cached at all.

| Scenario | Covers |
|---|---|
| **PG-A: Catalog & Schema Discovery** | Catalog, schemas, tables and declared column types — and pins that **no database table is cacheable** (0 of 40, with `createCache` enforced) |
| **PG-B: Data Correctness** | The mirror of `C`: the 100-row cap does **not** apply to raw queries — 25,000 rows counted, `LIMIT 500` returning 500, filters spanning the whole table |
| **PG-C: Export Endpoints** | The mirror of `K`: a table export captures **all** requested rows (1,000 of 1,000), not the Stripe cap |
| **PG-D: Materialized Query Endpoints** | The mirror of `N`: the stored snapshot holds the **whole table** (25,000 rows), not frozen at 100 |
| **PG-E: Connection Endpoints** | The mirror of `G`, and the only Postgres scenario needing real database credentials — everything else reuses the existing connection |
| **PG-F: Error Handling & Pagination** | Identifier-resolution errors (mirrors `F`), plus pagination proven **past** where Stripe's cap would stop — something `F` cannot demonstrate |
| **PG-G: Catalog Endpoints** | The mirror of `H` — and finds that table statistics, unsupported for Stripe, work fully for Postgres |
| **PG-H: Saved Query Endpoints** | The mirror of `I`: executing a saved query by name returns the whole table, a fourth independent route to the cap finding |
| **PG-I: Metadata Refresh Endpoints** | The mirror of `L`, against a catalog with ~10 real schemas rather than Stripe's one |

**The row cap is connector-specific — proven four independent ways** (raw queries, exports,
materialization, saved queries), **the string serialization is platform-wide.** Table statistics are
connector-specific too. See [FINDINGS.md](FINDINGS.md) for the full comparison.

Adding this folder is also what finally tested the "a new connector needs zero core changes" claim below.
It was **half true**: the framework was connector-agnostic, but `helpers/env.js` demanded
`STRIPE_TEST_TOKEN` of every run. Connector settings now live in `tests/<connector>/config.js`, and
`buildFreshCtx("postgres")` is the only line that differs in a Postgres test file.

> ⚠️ **`O` is the only scenario that writes to Stripe.** It creates one customer and deletes it again, so
> your sandbox's row counts are unchanged after a run. The id is tracked the instant it exists and
> [helpers/cleanup.js](helpers/cleanup.js) removes Stripe customers *before* any Peaka resource — a
> leftover customer would permanently shift the counts `C` asserts against. `helpers/stripeClient.js`
> refuses any key that isn't `sk_test_`.

A per-step breakdown is in [STRIPE_TEST_SCENARIOS.md](STRIPE_TEST_SCENARIOS.md).

### 🗂️ Peaka Tables — the internal Peaka Table / BI Table spec

`tests/peaka-tables/` covers the instructor's separate spec for Peaka's two built-in table types. Unlike
Stripe and Postgres, neither needs a connection or catalog of its own — both live in the project's
always-present `peaka` catalog, so this folder runs on nothing but `PEAKA_API_KEY`/`PEAKA_PROJECT_ID`.

Scenario names describe what each one establishes rather than carrying the spec's IDs — several assert
the *opposite* of what the spec predicts, and two have no spec counterpart at all.

| Scenario | Covers |
|---|---|
| **CSV import writes every row exactly as given** | The only real write path into a Peaka Table (`SqlExec` is SELECT-only — see [FINDINGS.md](FINDINGS.md)) |
| **A bad mapping silently writes NULL instead of failing** | The spec expects all four bad-mapping cases to fail; one of them silently succeeds and writes `NULL` — asserted as the real, measured behaviour |
| **Invalid values are rejected strictly and atomically** | The mirror of the above, and the opposite result: bad *values* are rejected with excellent messages. Pins a guarantee, so a drift toward the lax mapping handling is caught |
| **Repeated import appends instead of replacing** | Re-importing never replaces and never deduplicates — combined with the absent row edits, a Peaka Table can only ever **grow** |
| **The sample endpoint returns a type-aware template with example rows** | A **template** generator, and it conforms to the spec — including the import round trip. Sole deviation: an undeclared `text` column in the header. Required fixing a client bug (silently returned `null`) to measure at all |
| **Peaka Table columns rename and delete cleanly** / **BI Table silently ignores displayName on every column change** | The same operation on each table kind — BI Table's `displayName` never actually persists, despite the API claiming it did |
| **Deleting a table purges its data and its schema** | A genuine hard drop: recreating the same name gives a blank table with no declared columns, and ids are never reused. Pins the blank-slate assumption every other scenario depends on |
| **Schema changes apply cleanly to a table that already holds data** | The most customer-shaped scenario here — add a column to a populated table, drop one that holds data, relabel one. All working, all pinned |
| **Unique and not-null flags are silently discarded at column creation** | Sent `true`, stored `false`, `200` in between — a settable field whose write never takes. `defaultValue` is the control and works end to end |
| **A Peaka Table and BI Table sharing a name stay isolated** | Covers the spec's `CMP-01` — plus the collision the spec's own version never creates, since underscore stripping means one requested name yields two different tables |
| **A saved query tracks changes to the table beneath it** | Drop a column or the whole table and execution breaks with a clean `4xx` while the stored query survives — then recreating the table under the same name makes the query **silently re-bind** to the new data |
| **A federated join inherits the Stripe row cap** | The folder's only gated scenario. Joining an internal table to Postgres returns all 50,000 rows; joining it to Stripe silently truncates at 100 — so an aggregate over the join looks like an answer and is wrong |
| **Data survives an export and re-import unchanged** | The Excel loop. Uncapped at 150 rows, values identical on the way back — but the export carries all 8 system columns, so the mapping has to be filtered first |
| **A materialized query over an internal table never goes stale** | Peaka's docs promise a snapshot that ages between refreshes; over an internal table there is none — appended rows appear immediately. The inverse of the Stripe materialization bug |
| **BI Table rows are queryable and join to a Peaka Table** | Closes the spec's `CMP-02`. Rows entered via Studio are fully readable, so the Peaka Table side is seeded from values *discovered* in the BI Table at runtime — asserting invariants, so editing the data can't break it |
| **A populated BI Table refuses every documented write** | The docs promise row-by-row inserts, updates, deletes and bulk insertion; the API delivers none. With real rows present it proves the data is byte-identical afterwards — impossible against an empty table |
| **A BI Table exports into a Peaka Table which is the only way out** | No import route exists for BI Tables, so the round trip lands in a Peaka Table — the only API-writable destination. The export carries `_operation`, the ninth system column |
| **A materialized query over a BI Table agrees with the table underneath** | Deliberately does *not* claim whether a snapshot is held — with no write path the base can't be made to drift. Pins the thing a dashboard depends on: filters agreeing through the materialized query |
| **Cache creation on a BI Table fails before it can be refused** | Postgres returns a clean `TABLE_NOT_CACHEABLE`; internal tables die looking up a mangled internal identifier with `errorCode: null` — for both table kinds |
| **No row-level UPDATE or DELETE exists anywhere** | Not a feature test — a pinned absence. No row-level edit path exists via SQL or REST |
| **Joins across two Peaka Tables return correct groupings** | Adapted from the spec's Table×BI-Table join, which the Partner API cannot seed. **Now also covered directly** by the BI Table read/join scenario, using rows entered through Studio |

Several of the spec's own assumptions about the platform turned out to be wrong — see findings 9–16 in
[FINDINGS.md](FINDINGS.md) for the full list, including why roughly half its 24 scenarios can't be built
as literally written.

## Project layout

```
helpers/
  peakaClient.js            - thin wrapper over the Peaka Partner API (project-scoped)
  peakaAccount.js           - account-level discovery for the Connect screen (organizations ->
                              workspaces -> projects) + resolveDynamicConnectorConfig() (live
                              catalog/schema resolution for a picked project+connection)
  assert.js                 - assertion helpers, 5xx-aware (see serverError.js)
  serverError.js            - records 5xx responses so they can't pass silently
  step.js                   - runs a named sub-step, tagging errors with which step failed
  stepReporter.js           - emits live step events to the dashboard (no-op under npm test)
  buildCtx.js                - builds each scenario's isolated context
  env.js                    - .env loader + credential validation
  preflight.js              - measures the environment once; test.skip gating
  sweepConnections.js       - age-guarded cleanup of connections a killed run abandoned
  cleanup.js                - resource deletion (cache -> query -> table -> catalog -> connection)
  withTable.js              - create/run/delete lifecycle for Peaka Table / BI Table scenarios
  csvFixtures.js            - in-memory CSV generators, nothing written to disk
  resolveCatalogName.js     - resolves the catalog's SQL name
  pollCacheUntilComplete.js - waits for a cache sync to finish
  cacheExecution.js         - reads a cache's true current status (see FINDINGS.md)
  raceWindow.js             - timing primitives for the concurrency suite
  racePreflight.js          - refuses to start the races if another run is active
tests/
  stripe/                   - one folder per connector, auto-discovered by server.js
    meta.js                 - scenario metadata for the dashboard
    b-catalog-schema.js … n-materialized-queries.js
  hubspot/                  - same shape as stripe/, see "Adding another connector" below
    meta.js, config.js, checkTokenCredentials.js
    b-catalog-schema.js … n-materialized-queries.js
  postgres/                 - a second connector; fixture.js discovers its data at runtime
    meta.js
    pg-a-discovery.js … pg-i-metadata.js
  google-ads/               - the first connector in a SEPARATE Peaka project, with its own key
    meta.js, config.js, fixture.js (retry-tolerant; the connector is measurably flaky)
    ga-a-discovery.js … ga-h-queries.js
  peaka-tables/              - no connection/catalog needed; lives in the built-in `peaka` catalog
    meta.js
    csv-import-*.js (happy-path, mapping-errors, type-coercion, repeats-append),
    table-column-update.js, bitable-column-update.js, table-delete-purge.js,
    sample-endpoint.js, no-row-level-edit.js, internal-table-join.js
  races/
    meta.js
    tier1.js … tier4.js
  hubspot-races/            - HubSpot version of races/
    meta.js
    tier1.js, tier2.js, tier3.js
jest/
  stripe/
    connector.test.js       - B, C and F as test.concurrent() blocks
    g-connections.test.js … n-materialized-queries.test.js
  hubspot/                  - same shape as jest/stripe/
  postgres/                 - pg-a-discovery.test.js … pg-i-metadata.test.js
  peaka-tables/             - one *.test.js per scenario
  races/                    - tier1-4.test.js
  hubspot-races/            - tier1-3.test.js
  reporters/
    incompleteRun.js        - skip banner + server-error banner, coverage.json, exit code
  runInChild.js             - thin runCLI() wrapper, forked as its own OS process by server.js so
                              a run can be killed (the Stop button) - see "Stopping a run" above
  browserReporter.js        - custom reporter; POSTs results to the dashboard over HTTP, tagged
                              with the run's id (it runs inside the forked child, not server.js's
                              own process)
  google-ads/               - ga-*.test.js, one per scenario
public/                     - dashboard frontend (index.html, app.js, styles.css, favicon.svg)
server.js                   - dashboard backend (Express; forks one jest/runInChild.js per run,
                              several at a time - see "Running several connectors at once")
jest.config.js              - main suite config
jest.races.config.js        - concurrency suite config
jest.globalSetup.js         - runs preflight once before any test file loads
```

## Design decisions worth knowing

**Steps, not sub-tests.** Each scenario is one Jest test that runs a sequence of named `step(...)` calls.
If a step fails, later steps in that scenario do not run, and the error is prefixed with the step name:

```
✕ B: Catalog & Schema Discovery
  [list tables and check core tables present] Expected core tables missing...
```

This keeps genuine dependencies (read catalog → discover schema → discover tables) as plain sequential
`await`s instead of hidden ordering requirements between separate `test()` declarations.

**Two parallelism models.** `B`, `C` and `F` share one file as `test.concurrent()` blocks — concurrent
promises in a single worker. `G` through `N` each have their own file, so Jest schedules them across
separate worker processes. Both are safe because every scenario builds its own isolated context with its
own client and its own resource-tracking arrays; nothing is shared.

**Scenarios that create caches provision their own catalog.** `L`, `M`, `N` and the races each create a
throwaway connection and catalog rather than using the shared one. Caches attach to a catalog, and
querying a table whose cache is mid-sync returns zero rows — so a scenario caching a table another
scenario reads live is one scheduling accident away from a confusing failure. This is not hypothetical:
`N` hit it for real before being isolated.

**`C` and `D` were merged for the same reason.** Keeping cache behaviour separate from data correctness
required each to avoid the other's tables. Merged, the race is impossible and the live-versus-cached
difference becomes the *subject* of the test rather than a hazard to route around.

## Troubleshooting

**`Refusing to start the concurrency races — another test run appears to be active`**
Stop the dashboard, or whatever else is running, first. On Windows, Git Bash's `pkill` only sees its own
process tree and will silently kill nothing — use PowerShell:

```bash
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Running the races *from* the dashboard is supported and will not trip this check.

**`There is no catalog with this application and catalog id`**
`PEAKA_CATALOG_ID` points at a catalog that no longer exists — usually because it was deleted and
re-created in Studio. Update `.env` with the new id.

**`CORRUPTED CACHE STATE: [table] report isCached:true but no cache is listed`**
A real Peaka bug, not a test failure. See
[FINDINGS.md](FINDINGS.md#2-deleting-a-cache-can-permanently-break-a-table) — the repair is to rebuild
the catalog in Studio, keeping the same name.

**`connect EACCES <ip>:443`**
The process cannot open outbound connections. Most often the dev server was started in a restricted or
sandboxed shell; start it from a normal terminal.

**Tests failing in files you did not touch, with times roughly doubled**
That pattern is contention, not a regression. Something else is running against the same Peaka project —
check for a stray `node server.js` and confirm port 3000 is actually free.

Note that `npm run test:races | grep … && npm test` is a trap: `&&` sees *grep's* exit code, not Jest's,
so the second suite runs even when the first failed and then overlaps with it.

## Continuous integration

`.github/workflows/nightly-test.yml` runs `npm test` on a schedule rather than per-push — this suite
mostly catches Peaka- and Stripe-side drift, so a time-based cadence matters more than commit triggers.
It also exposes a manual **Run workflow** button.

Required repository secrets (**Settings → Secrets and variables → Actions**): `PEAKA_API_KEY`,
`PEAKA_PROJECT_ID`, `STRIPE_TEST_TOKEN`, `PEAKA_CATALOG_ID`, `PEAKA_SCHEMA_NAME`,
`EXPECTED_CUSTOMER_COUNT_NON_CACHE`, optionally the `PEAKA_PG_*` trio for the Postgres folder, optionally
the `PEAKA_MONGO_*` trio for the MongoDB folder, and optionally `SLACK_WEBHOOK_URL`. No `.env` is needed —
`helpers/env.js` prefers real environment variables.

**The HubSpot secrets (`HUBSPOT_ACCESS_TOKEN`, `PEAKA_HUBSPOT_CATALOG_ID`, `PEAKA_HUBSPOT_SCHEMA_NAME`)
are not yet added to `nightly-test.yml`.** Until they are, the HubSpot scenarios that need a token
(`G`/`H`/`L`/`M`/`N`) report as skipped in that run's output — add them the same way as the Stripe
secrets above once a dedicated CI HubSpot test account exists.

Note the CI job will **fail on an incomplete run**, which is the intended behaviour: a nightly that
silently stopped covering half the suite is worse than one that goes red. Set `ALLOW_INCOMPLETE=true`
only if you deliberately run CI against a partially-configured project.

**Use a dedicated Peaka project for automated runs**, separate from the one you test against manually.
Scheduled automation sharing a project with a human reintroduces exactly the resource-collision class
this suite already had to design around.

**The workflow deliberately does not use `jest.retryTimes()`.** Jest's built-in retry reports only the
last attempt, discarding the first failure's data. Several findings in FINDINGS.md were caught precisely
*because* nothing silently retried. Instead the suite runs once and, only on failure, runs again as a
separate visible step — so "failed once, passed on retry" is reported as flaky rather than hidden.

## Adding another connector

Proven four times now — Stripe was the original suite; HubSpot, Postgres and MongoDB were each added
later following this process, and each is what actually tested the "zero core changes" claim:

1. Create `tests/<connector>/config.js` (copy `tests/postgres/config.js` or `tests/hubspot/config.js` as
   a template) declaring `requiredEnv` (the env vars `helpers/env.js`'s `checkCredentials()` demands on top
   of the core `PEAKA_API_KEY`/`PEAKA_PROJECT_ID`), `catalogIdEnv`/`schemaEnv`/`catalogNameEnv`, and
   whether the connector `supportsCaching`. This is the one genuinely shared piece of infrastructure a new
   connector touches - and unlike the old `CONNECTOR_SPECS` object this replaced, it needs no edit to
   `helpers/env.js` itself, just a new file.
2. Create `tests/<connector>/` with your scenario files and a `meta.js` (copy `tests/hubspot/meta.js`),
   and `jest/<connector>/` with the matching test files (copy `jest/hubspot/connector.test.js` and the
   single-scenario `.test.js` files - each one calls `buildFreshCtx("<connector>")` and
   `requireCredentials("<connector>")` from `require("../../helpers/buildCtx")` to get a ctx scoped to
   that connector's credentials).
3. Optionally add `tests/<connector>-races/` + `jest/<connector>-races/` for deliberate concurrency tests,
   and widen `jest.races.config.js`'s `testMatch` to include the new folder.

`server.js` discovers folders under `tests/` at request time by looking for a `meta.js`, so the new folder
appears in the dashboard with no changes to the server or frontend - steps 2-3 alone are enough for that
part. A `tests/<name>/` folder with **no** `meta.js` stays correctly invisible in the dashboard (no broken
"0 scenarios" card) - useful if you start a connector's credential research (real shape confirmed against
Peaka's `listConnectionConfig()`) before writing its scenarios.

**Dashboard connector matching is keyed off `catalogType`, not `connectionType`.** `server.js`'s
`/api/peaka/projects/:projectId/connectors` lists connectors from a project's *catalogs*
(`listCatalogs()`), not `listConnections()` - confirmed the two can disagree (a project can have a
working catalog for a connector `listConnections` doesn't report at all). Name the `tests/<name>/` folder
to match the real `catalogType` string a live catalog of that connector reports (verify with
`listCatalogs()` against a real connection before naming the folder - Postgres's is uppercase
(`POSTGRES`), most others aren't, don't assume).

## Related documents

| Document | Contents |
|---|---|
| [FINDINGS.md](FINDINGS.md) | Peaka API bugs found, with evidence and reproduction steps |
| [STRIPE_TEST_SCENARIOS.md](STRIPE_TEST_SCENARIOS.md) | Step-by-step breakdown of every Stripe scenario |
| [HUBSPOT_TEST_SCENARIOS.md](HUBSPOT_TEST_SCENARIOS.md) | Step-by-step breakdown of every HubSpot scenario, plus how it differs from Stripe's |
| [CONCURRENCY-SPEC.md](CONCURRENCY-SPEC.md) | Design and results of the concurrency suite |
| [COVERAGE.md](COVERAGE.md) | Coverage against the original requirements |
