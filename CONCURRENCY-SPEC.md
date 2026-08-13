# Spec — deliberate concurrency conflicts on shared resources

**All four tiers are implemented** — `tests/races/tier{1,2,3,4}.js`, run with `npm run test:races`
(four sequential scenarios). One step remains gated and unrun: Tier 2 #4.

Tiers 1-3 ask *"does it error, or wedge?"*. **Tier 4** asks a different question — *does the API silently
write something wrong down and keep it?* — and was added 2026-08-04 after noticing that no existing race
covered durable damage, only transient failures. Supersedes the earlier `STATE-MACHINE-SPEC.md` proposal, which covered *sequential* state
transitions and states outright that it cannot express overlapping ones. This covers exactly that gap.

## Why this one has a track record

Every other testing idea in this repo is speculative. This one has already found a real bug — without
anybody aiming for it:

> Running `D` (creating a cache on `customers`) concurrently with `C` (querying `customers` live) made
> `C`'s count return **0** instead of the real value, in the exact window the new cache was still syncing.
> Peaka's query routing prefers an existing cache even before it holds any data.

That was found by accident, from test scheduling, and it was significant enough to force the `C`/`D` merge
and to push `F`'s pagination off `charges`. Two more races have been observed since without being chased:
`refreshMaterializedQuery` + `cancel` settles to `CANCELED` in seconds or sits at `RUNNING` past 90s on
identical code, and `cancelExport` racing completion returns `200` or `404` unpredictably.

So: overlapping operations on shared resources is where this API actually misbehaves.

## The conflict matrix

### Tier 1 — targets a known but unreproduced server error

| # | Overlap | What it targets |
|---|---|---|
| 1 | **`createCache` on a table whose cache is still `RUNNING`** | ✅ **REPRODUCED, first attempt** (2026-07-30). Returns `500 Internal Server Error`. See "Confirmed result" below — this case is no longer speculative and is now a deterministic reproduction |
| 2 | **`deleteCache` mid-sync** | ✅ **Tested — clean.** Returns `200` and `isCached` correctly flips to `false`; no orphan. Previously unexplored |
| 3 | **`triggerIncrementalUpdate` + `triggerFullRefresh` simultaneously** | ✅ **Tested — clean.** Both return `200`, the cache settles at `COMPLETED`, no wedge or corruption |

### Tier 2 — cross-resource, tests dependency-ordering assumptions

| # | Overlap | What it targets |
|---|---|---|
| 4 | **`deleteCatalog` while a cache on it is syncing** | ⚠️ **Implemented but GATED** behind `RUN_RISKY_RACES=true`, and skipped by default — it can strand a cache no endpoint enumerates. Never run yet |
| 5 | **`deleteConnection` while a query through its catalog is in flight** | ✅ **Tested — clean.** Queryable before, cleanly `400` after. The delete genuinely invalidates queries; nothing is served from stale connection state |
| 6 | **`deleteQuery` while an export of that query is running** | ✅ **Tested — clean.** Delete returns `200` mid-export and the export still reaches `SUCCEEDED`. Deleting a query does not break its in-flight export |
| 7 | **`updateConnection` to a bad token while a query is in flight** | ⚠️ **Inconclusive by construction** — see below. Peaka rejects an invalid token at update time (`400`), so the swap never happens and the credential-caching question stays open |

### Tier 3 — metadata and load

| # | Overlap | What it targets |
|---|---|---|
| 8 | **`refreshMetadata` concurrent with `listTables` / `listColumns`** | ✅ **Tested — clean**, but on thin evidence: see the caveat in the results below |
| 8b | **`listTables` during a cache sync** (the idea as originally stated) | ✅ **Tested — clean.** Prediction confirmed: metadata discovery is unaffected by an in-progress sync |
| 9 | **`refreshMetadata` twice concurrently** | ✅ **Tested — clean.** Both `200`, catalog settles, discovery intact afterwards |
| 10 | **20 parallel identical queries** | ✅ **Tested — clean.** All 20 returned `200` in ~2s, no rate limiting. Covers STRIPE-19 |

**Note on the original idea:** `listTables` during a *cache* sync is included as #8's cheap sibling, but I'd
expect it to be safe — `listTables` reads catalog metadata, not table data, so it never touches the syncing
path. The variant that actually broke was querying *rows*. Worth one step to confirm the prediction; the
metadata-vs-metadata race in #8 is the version with real teeth.

## The oracle problem

Nothing documents what *should* happen when you delete a catalog mid-sync. So assertions cannot be expected
values — they have to be invariants that must hold regardless of who wins the race:

| Invariant | Why it's the right thing to assert |
|---|---|
| **No `5xx` from either operation** | The project's existing stance, and what would have caught the original `500` |
| **Both responses parse and carry a message** | A race must not produce a raw stack trace |
| **The system reaches a terminal state within a bound** | Distinguishes "slow" from "permanently wedged" — the difference that mattered for the materialized-query cancel |
| **No orphaned resources** | After settling, every created resource is still enumerable and still deletable |
| **Reported success is observable** | If an operation returns `200`, its effect must actually be visible afterwards (e.g. `isCached` agrees) |

The last two are the ones worth building for. A `500` is easy to spot; a silently orphaned cache that no
endpoint lists and nothing can delete is the kind of thing only this style of test finds.

## Timing mechanics

Two distinct patterns, and conflating them is the main way this gets built wrong.

**Pattern A — enter the window, then fire.** For "do X while Y is running". Do *not* sleep and hope:

1. Start the slow operation (`createCache`).
2. **Poll `getCacheStatus` until it actually reports `RUNNING`.** This makes the overlap deterministic
   rather than probabilistic.
3. Fire the conflicting operation immediately.
4. Record both outcomes.
5. Wait for the system to settle, then assert the invariants.

**Pattern B — fire simultaneously.** For symmetric races (#3, #9, #10): `Promise.allSettled` on both calls
and assert over the collected results. `allSettled`, not `all` — one rejecting must not hide the other's
outcome.

Proposed helper: `helpers/raceWindow.js` exporting `duringSync(ctx, cacheId, conflictFn)` and
`simultaneously(fns)`, so the timing logic lives in one place rather than being re-improvised per test.

**Fixture choice inverts.** To overlap with a sync you need a *slow* one. Measured:

| Table | Rows | Sync | Suitability |
|---|---|---|---|
| `transfers` | 0 | 2.5s | Too fast — you'd never land inside it |
| `refunds` | 85 | 8.2s | Marginal |
| `customers` | 505 | ~37s | **Good window** |

That's the opposite of what `tests/stripe/m-cache-management.js` wants, which picks `transfers` for the
fastest possible sync. Worth noting explicitly so nobody "optimises" this onto `transfers` and quietly
destroys the overlap.

## Non-determinism

Races may simply not fire. **A test that fails because the race didn't happen is worse than no test** — it
trains people to ignore red.

So each scenario reports what actually occurred (who won, what each call returned) and asserts only the
invariants. If the conflicting call lands after the sync finished, that's logged as "window missed" and the
invariants still apply.

**"Window missed" is a result, not an excuse.** It is a legitimate outcome when the operation genuinely
finished first — but if a step reports it *every* time, the harness is broken, not lucky, and the step is
silently testing the idle path that the main suite already covers. Both new cancel steps hit exactly that:
the materialized-query one reported `status at fire: COMPLETED` on every run, because the status endpoint
serves the **previous** terminal status until the new run starts, so the poll gave up before the refresh
had begun. Watch the logged `entered window` values rather than the pass/fail — a green step that never
raced proves nothing.

Since 2026-07-31 the deliberate cancel races live here (Tier 1.4–1.6), moved out of `M` and `N`. Those two
used to trigger-and-cancel in the main suite, which made their outcomes depend on who won; they now settle
first and assert the idle contract exactly. Races belong in the race file.

## Harness self-test

Before trusting this on unknowns, point it at the race you already understand: **query a table's rows while
its cache is syncing → 0 rows.** Confirmed, and the reason `C` and `D` were merged.

A working harness reproduces that deliberately. If it can't, the harness isn't entering the window and every
green result is meaningless. Keep it as a permanent first step — it's the canary for the timing logic, not a
bug report.

## Execution model

**Its own command, never in `npm test`.** These tests manufacture races on purpose; running them alongside
the main suite creates *unintended* ones and produces failures that look like code regressions. That isn't
hypothetical — a stray `server.js` running a second suite against the same project produced a 3× slowdown
and four spurious failures during development.

Same mechanics as the other deferred specs: `testPathIgnorePatterns` in the main config, a second config
(`jest.races.config.js`, `maxWorkers: 1`), and an `npm run test:races` script.

**Also available in the dashboard** as its own ⚡ Concurrency Races folder — `tests/races/meta.js` was the
only file needed, since `server.js` discovers folders dynamically. Live per-step reporting makes a 4-minute
run watchable, which is exactly the case it was built for. The `runInProgress` guard prevents overlapping
dashboard runs, but don't start `npm test` in a terminal while the races run in the browser.

## Teardown

Harder here than anywhere else, because the point is to leave things in strange states.

- Track every created id and delete in `finally`, tolerating failure per-item (`helpers/cleanup.js` already
  works this way).
- **Retry deletion after a wait.** A resource that's mid-sync may refuse deletion on the first attempt.
- **Report what couldn't be cleaned up, loudly.** An orphaned resource is a *finding*, not just a mess —
  but it also needs manual attention, so it must be printed clearly rather than swallowed.
- **Scenario #4 is genuinely risky.** Deleting a catalog mid-sync could orphan a cache that no endpoint
  lists and nothing can delete. Recommend gating it behind an explicit opt-in (e.g. `RUN_RISKY_RACES=true`)
  rather than running it by default, and always against a throwaway catalog the test created — never
  `PEAKA_CATALOG_ID`.

## What this cannot do

- **Prove absence.** A green run means the races didn't fire *this time*, not that they're safe. Value comes
  from running it repeatedly over time, not from one pass.
- **Replace targeted regression tests.** Like the other generated/exploratory specs: let it find things,
  then write a named deterministic test per finding. That's exactly how the cap and the cache hangs ended up
  covered.
- **Cover multi-process races.** All of this races operations within one Node process against one API. Two
  independent clients hitting the same project — the human-plus-CI scenario the README warns about — is a
  different and harder problem.

## Confirmed result — Tier 1 #1 reproduces deterministically

Probed 2026-07-30 against `customers`, and it worked on the first attempt:

```
createCache                        -> 200 in 1326ms
getCacheStatus reports RUNNING     -> at 1995ms
duplicate createCache in-window    -> 500 Internal Server Error
original sync afterwards           -> COMPLETED at 32s
```

**This resolves a months-old open question.** Duplicate cache creation was recorded as behaving
inconsistently — `500` once, `200` four times — and treated as an unexplained anomaly. It isn't
inconsistent at all; it is **state-dependent**:

| Cache state when the duplicate is attempted | Result |
|---|---|
| sync still `RUNNING` | **`500 Internal Server Error`** |
| sync `COMPLETED` | `200` (silent get-or-create) |

Every historical observation fits: the single `500` was recorded as happening "while the original cache's
sync was still RUNNING", and all four `200`s were recorded after completion. Nobody had re-entered the
failing window deliberately since.

The bug is also **not destructive** — the original sync still reached `COMPLETED`, and the cache deleted
cleanly afterwards. So it's a bad error response to a legitimate request, not data loss.

Worth reporting to Peaka as: *"concurrent cache creation on a table with an in-progress sync returns 500
rather than the documented 409; reproducible in ~2 seconds."*

## Tier 1 results (implemented 2026-07-30)

`npm run test:races`, ~223s, one sequential scenario. Four steps, all passing:

| Step | Outcome |
|---|---|
| **Canary** — query rows mid-sync | Entered the window at 361ms, count came back **0** — reproduced the known routing bug, so the harness is provably entering the window |
| **1.1** duplicate `createCache` mid-sync | **`500` reproduced** at 282ms. Non-destructive: original sync still reached `COMPLETED`, cache still deleted |
| **1.2** `deleteCache` mid-sync | `200`, and `isCached` becomes `false`. **No orphan** — clean |
| **1.3** simultaneous incremental + full refresh | Both `200`, settled at `COMPLETED`. **No wedge** — clean |

Two of the three unknowns came back clean, which is a useful result rather than a disappointing one: it
narrows the suspicion to the create path specifically rather than cache concurrency in general.

The canary earns its place. It fired at 361ms and confirmed count `0`, which is what makes the two clean
results trustworthy — without it, "no bug found" and "never entered the window" look identical.

### Cancel races added 2026-07-31 (moved out of `M` and `N`)

Runtime rose to ~382s — each step triggers an operation and waits for it to settle twice over.

| Step | Outcome |
|---|---|
| **1.4** cancel a **running incremental** | Entered the window at `RUNNING`, cancel `200`, cache settled at **`CANCELLED`**, still deletable |
| **1.5** cancel a **running full refresh** | Entered at `RUNNING` (record absent before the trigger, as expected), cancel `200`, settled at **`CANCELLED`** |
| **1.6** cancel a **running materialized refresh** | Entered at `RUNNING`, cancel `200`, settled at **`CANCELED`** (one L), and a recovery refresh produced a genuinely new execution |

All three clean: cancelling something in flight is accepted, actually cancels, and never wedges the
resource. Combined with the idle case the main suite now pins (`404` for both cache endpoints), the cancel
contract is fully characterised for the first time — and the two halves are tested where they belong.

**1.6 failed to race on its first run** and reported `status at fire: COMPLETED` every time, silently
duplicating the idle case. The status endpoint serves the *previous* terminal status until the new run
starts, so `duringState`'s default give-up-on-terminal fired before the refresh began. It now ignores every
status until `lastExecutionStartTime` moves. The visible difference between the broken and fixed versions is
`entered window: false` → `true` and a settle at `COMPLETED` → `CANCELED` — both of which were in the logs
of a step that *passed*. Read the window telemetry, not the pass/fail.

## Tier 2 results (implemented 2026-07-30)

~17s, three steps run plus one skipped. All passing, **no bugs found** — which is a real result, and it
narrows the earlier `500` to the cache-create path rather than to cross-resource concurrency generally.

| Step | Outcome |
|---|---|
| **2.5** `deleteConnection` racing a query | Baseline `200` → raced query `200`, delete `200` → post-race query `400`. Clean |
| **2.6** `deleteQuery` mid-export | Delete `200` while the export was `RUNNING`; export still finished `SUCCEEDED`. Clean |
| **2.7** `updateConnection` to a bad token | Update **rejected with `400`** — Peaka validates the credential rather than accepting it blindly |
| **2.4** `deleteCatalog` mid-sync | Skipped (gated) |

**Two methodology corrections were needed, and both matter more than the results.**

*2.5 needed a baseline.* The first version raced a delete against a query on a freshly created catalog and
saw `400`. That was uninterpretable — it could mean "the connection was already gone" or simply "this
catalog isn't queryable yet because metadata discovery hasn't finished". Adding a baseline query *before*
the race is what makes the raced result mean anything, and it's what upgraded this step from noise to a
clean confirmation.

*2.7 was reporting a false finding.* It logged "the query still succeeds with an invalid token — the old
credential is cached", which sounds like a serious bug. But `updateConnection` had returned `400`: the swap
was **rejected**, so the connection still held the good token and the query succeeding proved nothing. The
step now only interprets the post-swap query when the swap actually took.

That leaves scenario 05's real question open. Probing it needs a token that is **well-formed and accepted at
update time but unauthorised at query time** — a revoked or wrong-account key — not an obviously fake
string. Worth noting the instructor's spec has the same gap: it says "update the token to an invalid value"
without addressing that Peaka may refuse it outright.

## Tier 3 results (implemented 2026-07-30)

~48s, four steps, all passing, **no bugs found**.

| Step | Outcome |
|---|---|
| **3.8** discovery during a metadata refresh | 113 tables before, 113 during, no empty or degraded result; refresh settled `NOT_ACTIVE` |
| **3.8b** `listTables` during a cache sync | Entered the window; `200` with 113 tables. **Prediction confirmed** |
| **3.9** two simultaneous `refreshMetadata` | Both `200`, settled `NOT_ACTIVE`, 113 tables intact afterwards |
| **3.10** 20 parallel queries | **All 20 → `200` in 2057ms.** No `429`, no `5xx`, nothing hung |

**3.8's evidence is thin, and worth saying so rather than claiming a clean bill of health.** Only *one*
sample landed while the refresh was in a non-terminal state — a metadata refresh on a freshly created
catalog settles in about a second, which is barely longer than one poll cycle. So the step proves discovery
wasn't broken in that one sample, not that it can never be. Strengthening it would need a catalog with
substantially more to rebuild, or a way to slow the refresh down. The invariant it checks (discovery must
never return an *empty* table list mid-refresh) is the right one — there just isn't much window to check it in.

**3.10 is the most reassuring result.** 20 concurrent queries all succeeded in ~2s with no backpressure at
all, which says the API handles read concurrency comfortably. It also means the instructor's scenario 19
passes trivially rather than revealing anything — worth knowing before treating it as a meaningful test.

### Re-verified 2026-08-03, after the `cacheExecution` change

`helpers/cacheExecution.js` made settling stricter — the most recent execution record *and* the top-level
status must both be terminal. Tier 1 was re-run at the time; Tiers 2 and 3 were not, leaving the only
affected call (`waitForSettled` in 3.8b) unverified. Both re-run clean:

| Check | Result |
|---|---|
| Tier 2 | **PASS**, 24s |
| Tier 3 | **PASS**, 109s (was ~48s; the metadata refreshes are slower on a fresh catalog) |
| 3.8b `waitForSettled` under the stricter check | Settled normally — no regression |
| 3.10 20 parallel queries | All `200` in 10.3s, slower than the original 2.1s but no failures |

**Tier 2 never depended on the change at all** — it imported `waitForSettled` without ever calling it.
That dead import has been removed.

**`duringExport` enters its window, so 2.6 is a real race.** This was an open question after Tier 1.6
turned out to have been silently testing the idle path. Measured: `entered window: true, export status at
fire: RUNNING`. The trap that caught 1.6 structurally cannot apply here — `duringExport` polls a *freshly
created* export id, which has no previous run whose terminal status could linger, whereas a materialized
query's status endpoint serves the prior terminal value until a new run starts.

### 3.8b was writing to the shared catalog (fixed 2026-08-03)

Found while re-verifying, and unrelated to the change above. 3.8b cached `customers` into
**`PEAKA_CATALOG_ID`** — precisely the hazard Tier 1 was moved off. Any interruption between its create
and delete leaves `customers` cached in the catalog `C` depends on, which is exactly what happened once
when a dashboard server died mid-run and `C` then skipped its whole live phase.

It also made this file's sibling claim in `tests/races/tier3.js` untrue: the header asserted Tier 3 could
not disturb `B` and `C`, which held for the metadata steps and not for this one. 3.8b now uses the same
`throwawayCatalog()` helper as the rest of the file and asserts the id is never the shared one.

## Tier 4 results (implemented 2026-08-04)

~38s, one scenario. A different question from Tiers 1-3, which all ask *"does it error, or wedge?"*:
**does the API silently write something wrong down and keep it?** That matters because this suite's
headline finding — the 100-row cap — is a silent truncation, not an error.

All three artifacts are built inside a **single** initial-sync window rather than three separate ones,
which is both cheaper and a closer model of a busy system.

| Step | Outcome |
|---|---|
| **4.1** export started mid-sync | **`FAILED`**, no `rowCount`. The identical export after the sync settled **`SUCCEEDED` with 506 rows** |
| **4.2** source row created mid-sync | Picked up by the running sync itself — **not lost**. No follow-up refresh needed |
| **4.3** materialized query built mid-sync | **Captured ZERO rows, permanently** |

**4.1 needed a control before it meant anything.** The first run reported `FAILED` and nothing more, which
is uninterpretable — it could equally mean "exports of this query never work". Re-running the same export
against the settled cache is what attributes the failure to the sync. Worth noting the behaviour is
arguably *good*: failing loudly beats exporting an empty CSV that reports success.

**4.2 is the reassuring result.** A watermark-based sync that advanced past a row written during the sync
would lose it permanently. It does not — the running sync picked it up. The step still keeps its
incremental-then-full-refresh ladder so a regression would be caught and attributed.

**4.3 is the finding this tier was built for.** A materialized query is a stored snapshot (verified: adding
a row upstream does not change it without a refresh), so a snapshot taken while the source reads as empty
stays empty forever, with nothing indicating the data is wrong.

Worth knowing: the non-raced baseline is already broken. A materialized query over an *uncached* table
captures **100 rows of 505** — the live cap, frozen — with no race involved at all. See `FINDINGS.md` #2.
The race makes a bad situation worse (0 instead of 100) rather than creating it.

**Both 4.1 and 4.3 are reported, never asserted**, following Tier 1's duplicate-create precedent:
asserting the broken outcome would institutionalise it, asserting the healthy one would be permanently
red until Peaka fixes it.

## Across all four tiers

Ten conflicts tested, **one bug found** — the duplicate-`createCache` `500`, which was already suspected and
is now deterministic. Everything else came back clean.

That is a genuinely useful outcome, not a disappointing one: it isolates the failure to the **cache-create
path specifically**, rather than leaving "Peaka might have concurrency problems" as an open worry across
caches, connections, catalogs, queries, exports, metadata and parallel load.


## Hardening pass (2026-07-30) — tests that could not fail

A review found several steps that passed regardless of outcome. Fixed:

| Was | Now |
|---|---|
| **Tier 1 ran against the SHARED catalog** — an interrupted run left `customers` cached, which makes `C` silently skip its whole live phase. This happened for real when a dashboard server died mid-run | Tier 1 provisions its **own connection + catalog**. The independent copy of `customers` has the same 505 rows and ~37s sync, so the race window is unchanged, but `C` can no longer be affected. Asserts the race catalog is never `PEAKA_CATALOG_ID` |
| **The canary only logged.** If the harness stopped entering the sync window, all three tiers would go green having measured nothing | Hard-fails when `enteredWindow === false` — that's a property of *our harness*. A non-zero count still only logs, because that's *Peaka's* behaviour and a fix must not turn the suite red. Failure path verified reachable against a settled cache |
| **The final step warned and then re-asserted the HTTP status** — the one thing it existed to check was the one thing it could not fail on | Remedies first (delete the leftover cache), then asserts `isCached === false`, failing only if it cannot be cleared |
| **Nothing detected a concurrent run** | `helpers/racePreflight.js` refuses to start if the dashboard is serving on port 3000 or any cache is mid-sync. Verified: with the dashboard up, the suite now refuses with an actionable message instead of producing minutes of confusing red |
| **600s timeout vs 407s observed** under contention | Raised to 1200s, so contention surfaces as the real failure rather than a timeout |

The equivalent problem outside the races was fixed too: `C`'s `skipLivePhase` now **clears leftover caches
and runs the live phase** rather than silently disabling eight steps, and the cascading
`if (!created) return` guards in `j-internal-tables.js` plus the dead guard in `k-exports.js` were removed —
both laundered real failures into passes.

## Open questions worth resolving first

- ~~Does `getCacheStatus` report `RUNNING` promptly enough to make Pattern A reliable?~~ **Answered: yes.**
  `RUNNING` appears ~2s after `createCache` returns, and the window stays open ~30s on `customers`. Pattern A
  is comfortably viable.
- Is there any way to *list* orphaned caches? The schema-level all-statuses endpoint returns `500`, and the
  project-level one is the only enumeration available — if an orphan doesn't appear there, invariant 4
  becomes untestable and cleanup becomes manual. Still open, and it gates Tier 2 #4.
