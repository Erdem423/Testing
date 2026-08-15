# Peaka Connector Test Suite (Stripe + HubSpot)

An end-to-end Jest suite that validates [Peaka](https://peaka.com)'s connectors against the real
[Peaka Partner API](https://docs.peaka.com/api-reference/introduction) and seeded sandbox data. Started as a
Stripe-only suite; a HubSpot connector was added later following the same architecture (see "Adding another
connector" below) - this README covers both.

Peaka is a data-integration platform: you connect a source (Stripe, HubSpot, ...), it exposes the source's
tables through a SQL interface, and it can *cache* those tables locally for faster reads. This suite
checks that the whole chain works — connection → catalog → schema → tables → queries → caches — and that
the data coming out is actually correct.

**There are no mocks.** Every test talks to a live Peaka project and live sandbox accounts (Stripe test
mode, a HubSpot test account). That is the point: the failures worth finding are in the real API's
behaviour, not in a stub of it. It also means runs take real time, need credentials, and create and
delete real resources.

**The HubSpot connector's tests are newer and less battle-tested than Stripe's.** Stripe's suite reflects
months of iteration against real data (see FINDINGS.md's confirmed bugs). HubSpot connections in Peaka are
**OAuth2** (confirmed via `getConnectionConfig("hubspot")` - credential fields
`accessToken`/`refreshToken`/`clientId`/`clientSecret`/`redirectUrl`), unlike Stripe's simple `sk_test_...`
secret key, so `HUBSPOT_ACCESS_TOKEN` (see below) is a different kind of credential to obtain - likely a
HubSpot **Private App token**, though that hasn't been confirmed accepted by Peaka yet. `checkCredentials()`
requires it for **every** HubSpot scenario, even `B`/`C`/`F`/`I`/`J`/`K` which never read it (they only
query the pre-existing catalog, never create a new connection) - until it's set, all HubSpot scenarios
report as **skipped**, not failed.

**Tried and rejected: giving `H`/`L`/`M`/`N` a token-free path by attaching their isolated catalog to the
already-working connection behind the shared `PEAKA_HUBSPOT_CATALOG_ID`**, instead of creating a new
connection. `createCatalog()` accepts any `connectionId` in principle, so this looked promising - but Peaka
returned a real `500 Internal Server Error` every time, reproduced consistently across all four scenarios.
Whatever the exact constraint is, Peaka does not support attaching a second catalog to a connection that
already has one - confirmed against the live API, not assumed. So `G`, `H`, `L`, `M`, `N` all genuinely need
their own connection, token and all. Several assertions in the HubSpot files are also deliberately looser than their Stripe
equivalents (e.g. no assumed live-query row cap, no assumed table-statistics limitation)
because those Stripe behaviours are measured facts about Stripe's connector, not general Peaka behaviour -
see the comments in `tests/hubspot/*.js` for what's confirmed vs. still open.

## What it found

Testing against the real API surfaced several genuine product bugs. Full write-ups, with evidence and
reproduction steps, are in **[FINDINGS.md](FINDINGS.md)**.

| Finding | Severity |
|---|---|
| Live (uncached) queries silently return at most **100 rows** — any query, not just `COUNT(*)` | **High** |
| Deleting a cache can leave a table **permanently unreachable** through Peaka | **High** |
| Duplicate `createCache` during an in-progress sync returns `500`, not the documented `409` | Medium |
| `cancelFullRefresh` throws a `NullPointerException` on a null execution record | Medium |
| Some cacheable tables produce cache jobs that hang forever, **indistinguishably from healthy** | Medium |

FINDINGS.md also documents two bugs found in *this suite* that produced green tests proving nothing —
worth reading before adding assertions of your own.

## Prerequisites

- **Node.js ≥ 18** (uses the built-in `fetch`)
- For Stripe: a **Peaka** project with a Stripe connection and catalog already set up in Peaka Studio, and
  a **Stripe test account** with seeded data — customers, charges, subscriptions and invoices. Several
  tests assert on real counts and distributions, so an empty sandbox will not do.
- For HubSpot: a **Peaka** project with a HubSpot connection and catalog already set up in Peaka Studio
  (scoped to the `crm` schema — contacts, companies, deals), and seeded HubSpot test data. A
  `HUBSPOT_ACCESS_TOKEN` credential is also required — HubSpot connections in Peaka are OAuth2, so this is
  a different kind of credential than Stripe's key (see the `.env` table below and "What it found" above).
- You only need to set up the connector(s) you intend to run — see "Setup" below.

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
PEAKA_API_KEY=your_peaka_partner_api_key
PEAKA_PROJECT_ID=your_peaka_project_id

# Stripe connector
STRIPE_TEST_TOKEN=sk_test_your_stripe_test_key
PEAKA_CATALOG_ID=your_existing_peaka_catalog_id
PEAKA_CATALOG_NAME=stripe
PEAKA_SCHEMA_NAME=payment
NUM_CUSTOMERS=505
EXPECTED_CUSTOMER_COUNT_NON_CACHE=100

# HubSpot connector - OAuth2, see the table below before filling this in
HUBSPOT_ACCESS_TOKEN=your_hubspot_access_token
PEAKA_HUBSPOT_CATALOG_ID=your_existing_hubspot_catalog_id
PEAKA_HUBSPOT_CATALOG_NAME=hubspot
PEAKA_HUBSPOT_SCHEMA_NAME=crm
NUM_CONTACTS=your_real_contact_count
EXPECTED_CONTACT_COUNT_NON_CACHE=100
```

Each connector's credentials are independent - set only Stripe's, only HubSpot's, or both. A connector
with missing/placeholder credentials has its scenarios reported as **skipped** (not failed) by both
`npm test` and the dashboard; the other connector runs normally.

| Variable | Where it comes from |
|---|---|
| `PEAKA_API_KEY` | Peaka Studio → Developer ([guide](https://docs.peaka.com/how-to-guides/how-to-manage-partner-api-key)) |
| `PEAKA_PROJECT_ID` | Your project's URL or settings in Peaka Studio |
| `STRIPE_TEST_TOKEN` | A Stripe **test-mode** key — either a secret key (`sk_test_…`) or a restricted key (`rk_test_…`, scoped to read access on customers/charges/subscriptions/invoices/etc. is enough). The suite refuses to run against a live key |
| `PEAKA_CATALOG_ID` | An existing Stripe catalog, created alongside its connection in Studio. `B` reads this catalog rather than creating one |
| `PEAKA_CATALOG_NAME` | The Stripe catalog's SQL-queryable name. Used as a fallback if the live lookup fails |
| `PEAKA_SCHEMA_NAME` | The Stripe connector's schema, e.g. `payment`. `B` cross-checks it against a live `listSchemas` |
| `NUM_CUSTOMERS` | Your **real** Stripe customer count — `C` compares cached reads against it |
| `EXPECTED_CUSTOMER_COUNT_NON_CACHE` | The known Stripe live-query cap (`100`). A deliberate regression test — see [FINDINGS.md](FINDINGS.md#1-live-queries-cannot-return-more-than-100-rows) before changing it |
| `HUBSPOT_ACCESS_TOKEN` | A HubSpot **access token**. Confirmed via `getConnectionConfig("hubspot")` that Peaka's HubSpot connections are OAuth2 (fields: `accessToken`/`refreshToken`/`clientId`/`clientSecret`/`redirectUrl`) — a HubSpot **Private App token** is the most likely candidate value here (long-lived, no OAuth redirect needed to obtain) but hasn't yet been confirmed accepted by Peaka. Required by `checkCredentials()` for **every** HubSpot scenario, even ones that never read it (`B`/`C`/`F`/`I`/`J`/`K`) |
| `PEAKA_HUBSPOT_CATALOG_ID` | An existing HubSpot catalog, created alongside its connection in Studio. `B` reads this catalog rather than creating one |
| `PEAKA_HUBSPOT_CATALOG_NAME` | The HubSpot catalog's SQL-queryable name. Used as a fallback if the live lookup fails |
| `PEAKA_HUBSPOT_SCHEMA_NAME` | The HubSpot connector's schema holding the core CRM objects, e.g. `crm` (HubSpot also exposes `conversations`, `crm_associations`, `scheduler`, `settings` — out of scope for this suite) |
| `NUM_CONTACTS` | Your **real** HubSpot contact count — mirrors `NUM_CUSTOMERS` |
| `EXPECTED_CONTACT_COUNT_NON_CACHE` | Placeholder only — **no live-query row cap has been confirmed for HubSpot** (unlike Stripe's measured 100-row cap). See `tests/hubspot/c-data-and-cache.js` before relying on this value |

> ⚠️ `.env` holds real credentials and is git-ignored. Do not commit it.

## Running

```bash
npm test                 # the main suite, ~85s
npm run test:races       # the concurrency suite, ~10 min (see below)
npm run web              # browser dashboard at http://localhost:3000
```

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

A per-step breakdown is in [STRIPE_TEST_SCENARIOS.md](STRIPE_TEST_SCENARIOS.md).

## Project layout

```
helpers/
  peakaClient.js            - thin wrapper over the Peaka Partner API (project-scoped)
  peakaAccount.js           - account-level discovery for the Connect screen (organizations ->
                              workspaces -> projects) + resolveDynamicConnectorConfig() (live
                              catalog/schema resolution for a picked project+connection)
  assert.js                 - assertion helpers
  step.js                   - runs a named sub-step, tagging errors with which step failed
  stepReporter.js           - emits live step events to the dashboard (no-op under npm test)
  buildCtx.js                - builds each scenario's isolated context
  env.js                    - .env loader + credential validation
  cleanup.js                - resource deletion (cache -> query -> table -> catalog -> connection)
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
    meta.js
    b-catalog-schema.js … n-materialized-queries.js
  races/
    meta.js
    tier1.js, tier2.js, tier3.js
  hubspot-races/            - HubSpot version of races/
    meta.js
    tier1.js, tier2.js, tier3.js
  postgresql/, google_ads/  - NOT real connectors yet, just a NOTES.md each with the connector's
                              real, verified Peaka credential shape - see "Adding another connector"
jest/
  stripe/
    connector.test.js       - B, C and F as test.concurrent() blocks
    g-connections.test.js … n-materialized-queries.test.js
  hubspot/                  - same shape as jest/stripe/
  races/                    - tier1-3.test.js
  hubspot-races/            - tier1-3.test.js
  runInChild.js             - thin runCLI() wrapper, forked as its own OS process by server.js so
                              a run can be killed (the Stop button) - see "Stopping a run" above
  browserReporter.js        - custom reporter; POSTs results to the dashboard over HTTP (it now
                              runs inside the forked child, not server.js's own process)
  reporterBus.js
public/                     - dashboard frontend (index.html, app.js, styles.css, favicon.svg)
server.js                   - dashboard backend (Express; forks jest/runInChild.js per run)
jest.config.js              - main suite config (both connectors' non-race scenarios)
jest.races.config.js        - concurrency suite config (both connectors' race scenarios)
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
`PEAKA_PROJECT_ID`, `STRIPE_TEST_TOKEN`, `PEAKA_CATALOG_ID`, `PEAKA_SCHEMA_NAME`, `NUM_CUSTOMERS`,
`EXPECTED_CUSTOMER_COUNT_NON_CACHE`, and optionally `SLACK_WEBHOOK_URL`. No `.env` is needed —
`helpers/env.js` prefers real environment variables.

**The HubSpot secrets (`HUBSPOT_ACCESS_TOKEN`, `PEAKA_HUBSPOT_CATALOG_ID`, `PEAKA_HUBSPOT_SCHEMA_NAME`,
`NUM_CONTACTS`) are not yet added to `nightly-test.yml`.** Until they are, the workflow runs Stripe's
suite as before and the HubSpot scenarios report as skipped in that run's output — add them the same way
as the Stripe secrets above once a dedicated CI HubSpot test account exists.

**Use a dedicated Peaka project for automated runs**, separate from the one you test against manually.
Scheduled automation sharing a project with a human reintroduces exactly the resource-collision class
this suite already had to design around.

**The workflow deliberately does not use `jest.retryTimes()`.** Jest's built-in retry reports only the
last attempt, discarding the first failure's data. Several findings in FINDINGS.md were caught precisely
*because* nothing silently retried. Instead the suite runs once and, only on failure, runs again as a
separate visible step — so "failed once, passed on retry" is reported as flaky rather than hidden.

## Adding another connector

Proven twice now — Stripe was the original suite, HubSpot was added later following exactly this process:

1. Add an entry to `CONNECTOR_SPECS` in `helpers/env.js` (token/catalog-id/schema-name/catalog-name env var
   names, and a token prefix to validate if the connector uses simple bearer-token credentials like
   Stripe's `sk_test_...` — leave it `null` if unconfirmed, like HubSpot's).
2. Create `tests/<connector>/` with your scenario files and a `meta.js` (copy `tests/hubspot/meta.js` as
   the more recent template), and `jest/<connector>/` with the matching test files (copy
   `jest/hubspot/connector.test.js` and the single-scenario `.test.js` files — each one calls
   `require("../../helpers/buildCtx")("<connector>")` to get a ctx builder scoped to that connector's
   credentials).
3. Optionally add `tests/<connector>-races/` + `jest/<connector>-races/` for deliberate concurrency tests,
   and widen `jest.races.config.js`'s `testMatch` to include the new folder.

`server.js` discovers folders under `tests/` at request time by looking for a `meta.js`, so the new folder
appears in the dashboard with no changes to the server or frontend — steps 2-3 alone are enough for that
part. Step 1 is the one genuinely shared piece of infrastructure a new connector touches. A `tests/<name>/`
folder with **no** `meta.js` stays correctly invisible in the dashboard (no broken "0 scenarios" card) -
this is deliberate, see `tests/postgresql/NOTES.md` and `tests/google_ads/NOTES.md` below.

**`tests/postgresql/` and `tests/google_ads/` are started, not finished** - each has a `NOTES.md` with that
connector's real credential shape, confirmed live against Peaka's `listConnectionConfig()` (not guessed),
plus a structural gap worth knowing before writing real scenarios: unlike Stripe (`token`) and HubSpot
(`accessToken`), Postgres needs six credential fields (`url`/`port`/`user`/`password`/`databaseName`/
`useSsl`) and Google Ads needs OAuth2 + a `customerId` - `CONNECTOR_SPECS`'s current one-`tokenVar`-per-
connector shape in `helpers/env.js` will need extending for either, so step 1 above isn't a straight
copy-paste for these two the way HubSpot was from Stripe.

**Dashboard connector matching is keyed off `catalogType`, not `connectionType`.** `server.js`'s
`/api/peaka/projects/:projectId/connectors` lists connectors from a project's *catalogs*
(`listCatalogs()`), not `listConnections()` - confirmed the two can disagree (a project can have a
working catalog for a connector `listConnections` doesn't report at all). Name the `tests/<name>/` folder
to match the real `catalogType` string a live catalog of that connector reports (verify with
`listCatalogs()` against a real connection before naming the folder - `POSTGRES` is uppercase, most
others aren't, don't assume).

## Related documents

| Document | Contents |
|---|---|
| [FINDINGS.md](FINDINGS.md) | Peaka API bugs found, with evidence and reproduction steps |
| [STRIPE_TEST_SCENARIOS.md](STRIPE_TEST_SCENARIOS.md) | Step-by-step breakdown of every Stripe scenario |
| [HUBSPOT_TEST_SCENARIOS.md](HUBSPOT_TEST_SCENARIOS.md) | Step-by-step breakdown of every HubSpot scenario, plus how it differs from Stripe's |
| [CONCURRENCY-SPEC.md](CONCURRENCY-SPEC.md) | Design and results of the concurrency suite |
| [COVERAGE.md](COVERAGE.md) | Coverage against the original requirements |
