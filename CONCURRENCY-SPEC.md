# Spec — deliberate concurrency conflicts on shared resources

**Tier 1 is implemented** (`tests/stripe/races-tier1.js`, `npm run test:races`); Tiers 2-3 are still
proposals. Companion to `STATE-MACHINE-SPEC.md`, which covers *sequential* state
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
| 4 | **`deleteCatalog` while a cache on it is syncing** | `helpers/cleanup.js` deletes cache→catalog→connection *precisely because* of dependency order. This tests whether the API enforces that or lets you orphan a cache. ⚠️ Genuinely risky — see Teardown |
| 5 | **`deleteConnection` while a query through its catalog is in flight** | Same class, one level up |
| 6 | **`deleteQuery` while an export of that query is running** | Does the export fail cleanly, or become a broken job referencing nothing? |
| 7 | **`updateConnection` to a bad token while a query is in flight** | Also closes the untested half of spec scenario 05 — if the in-flight query succeeds *and* subsequent ones do too, credentials are cached somewhere they shouldn't be |

### Tier 3 — metadata and load

| # | Overlap | What it targets |
|---|---|---|
| 8 | **`refreshMetadata` concurrent with `listTables` / `listColumns`** on the same catalog | Discovery reading metadata while metadata is being rebuilt |
| 9 | **`refreshMetadata` twice concurrently** | |
| 10 | **20 parallel identical queries** | Rate-limit behaviour; also covers the instructor's STRIPE-19 |

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

That's the opposite of `STATE-MACHINE-SPEC.md`, which wants the fastest possible sync. Worth noting
explicitly so nobody "optimises" this onto `transfers` and quietly destroys the overlap.

## Non-determinism

Races may simply not fire. **A test that fails because the race didn't happen is worse than no test** — it
trains people to ignore red.

So each scenario reports what actually occurred (who won, what each call returned) and asserts only the
invariants. If the conflicting call lands after the sync finished, that's logged as "window missed" and the
invariants still apply. This is the same shape `N`'s cancel step already uses after it passed once and hung
once on identical code.

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

Same mechanics as the other deferred specs: `testPathIgnorePatterns` in the main config, a second config,
and an `npm run test:races` script.

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

## Open questions worth resolving first

- ~~Does `getCacheStatus` report `RUNNING` promptly enough to make Pattern A reliable?~~ **Answered: yes.**
  `RUNNING` appears ~2s after `createCache` returns, and the window stays open ~30s on `customers`. Pattern A
  is comfortably viable.
- Is there any way to *list* orphaned caches? The schema-level all-statuses endpoint returns `500`, and the
  project-level one is the only enumeration available — if an orphan doesn't appear there, invariant 4
  becomes untestable and cleanup becomes manual. Still open, and it gates Tier 2 #4.
