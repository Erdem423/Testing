# Spec — randomized state-machine exploration of the cache API

Proposal, not implemented. Companion to `PAIRWISE-SPEC.md`, and a better-motivated one.

## Why this rather than pairwise

Of the five real bugs this project has found, **one is sequential** — and it's unreproduced:

> `500` once, when a duplicate `createCache` was attempted **while the original cache's sync was still
> `RUNNING`**; `200` in every observation afterward, once the cache had completed.

That is not a duplicate-creation bug. The same call returns `200` or `500` depending on the resource's
*state*. It was found by accident, it has never been reproduced deliberately, and nothing in the suite
explores that dimension. Randomized state-machine exploration is the technique that reproduces that class
on purpose.

By comparison, zero of the five findings were parameter-interaction bugs — see the honest revision in
`PAIRWISE-SPEC.md`. Sequencing is where this API has actually misbehaved.

## Scope

**The cache lifecycle only.** Connections and catalogs stay fixed (reuse `PEAKA_CATALOG_ID` as the existing
suite does). Rationale: the cache state machine is small, fully enumerable, has a confirmed bug in it, and
its endpoints — `incrementalUpdate`, `fullRefreshUpdate`, `cancelFullRefreshUpdate` — had their paths
corrected in PR #3 and are still **called by no test at all**.

States, per table: `none → creating → RUNNING → COMPLETED`, plus `FAILED` / `CANCELLED` / `DELETED`.

## Operations

Each is a command with a precondition, an expected outcome, and — where known — a reason it's interesting.
The generator only picks commands whose precondition currently holds, so sequences are valid by
construction rather than mostly-garbage.

| Command | Precondition | Expected | Why it's interesting |
|---|---|---|---|
| `CreateCache` | always | `200` or `409`. **Never `500`** | The known bug: `500` when fired mid-sync |
| `GetStatus` | cache believed to exist | `200`, status in the documented enum | Cheap; drives the model forward |
| `DeleteCache` | cache believed to exist | `200` | Deleting **while `RUNNING`** is unexplored |
| `TriggerIncremental` | cache exists | `200`, or `4xx` if illegal | Firing while a sync is already running |
| `TriggerFullRefresh` | cache exists | `200`, or `4xx` | Full refresh while incremental is running |
| `CancelFullRefresh` | cache exists | `200` if running, `404` if not | `404` shape already confirmed by hand |
| `WaitForSettle` | cache exists | reaches a terminal state | The only way to reach `COMPLETED` |
| `QueryTable` | always | `200` | Querying mid-sync — see harness self-test below |

`CreateCache` deliberately has **no** precondition. Duplicate creation is a legal call with interesting
state-dependent behavior; gating it would exclude the one bug we're chasing.

## Oracles, in increasing strength

Start weak. The weak oracle alone would have caught the `500`.

- **L0 — never a server error.** No `5xx` on any command, in any state. Every response parses; every error
  carries a readable message. This is your instructor's rule 7 turned into a generator.
- **L1 — documented status codes.** Each command's response is in its expected set above.
- **L2 — model agreement.** Track expected state in JS and assert observed status is consistent (e.g. after
  `DeleteCache`, `GetStatus` should not report `COMPLETED`). More power, more work; add later.

Build L0 + L1 first.

## Fixture: choose for sync speed, not size

This machine tests *transitions*, not data, so the fixture should be whatever syncs fastest. Already
measured:

| Table | Rows | Sync time |
|---|---|---|
| `transfers` | 0 | **2.5s** |
| `refunds` | 85 | 8.2s |
| `customers` | 505 | ~37s |

`transfers` is ideal — a 0-row table still produces a full `COMPLETED` execution record with real
`progress` fields, at roughly a fifteenth of the cost. This is what makes randomized walks affordable at
all; on `customers` a 10-step walk would take most of an hour.

Neither `transfers` nor `refunds` is cached by any test, so nothing collides — and this runs under its own
command anyway (same reasoning as `PAIRWISE-SPEC.md`).

## Reproducibility

Non-negotiable, and the thing that decides whether this is useful or just noise. A random suite that fails
differently every run is exactly what this project has refused elsewhere (no `jest.retryTimes`, "a failure
should mean something real").

- **Seeded**, with the seed settable and printed on every run: `EXPLORE_SEED=12345 npm run test:explore`.
- **Every command logged as it executes**, with the resulting status, so the transcript *is* the repro.
- **Shrinking.** When a 12-step walk fails you want the minimal 3-step sequence that still fails. This is
  the single most valuable feature and the main argument for using [`fast-check`](https://fast-check.dev)'s
  `fc.commands` rather than hand-rolling — it does model-based testing with automatic shrinking.

**Dependency note:** `fast-check` would be the project's first non-Jest test dependency, and the helpers
have a deliberate zero-dependency streak (`pairwiseGenerate.js` was written from scratch on purpose). A
hand-rolled random walk is genuinely easy; *shrinking* is the hard part, and without it a 12-step failing
sequence is nearly useless. That's the trade — I'd take the dependency.

## Cleanup, without a list endpoint

Randomized order means unpredictable leftovers, and there's no per-table "list caches" endpoint. The
schema-level status endpoint that would serve returns `500` (documented in the README).

Workaround, using behavior already confirmed: **`createCache` is get-or-create.** Calling it returns the
existing cache's id if one exists, which can then be deleted. So "ensure no cache on this table" is
`create → delete`, needing no list endpoint.

Caveat: if the existing cache is mid-sync, the create may hit the very `500` being hunted — so the reset
routine should `GetStatus` first and settle before creating. Track every id returned during a walk and
delete all of them in a `finally`, mirroring `ctx.createdCacheIds`.

## Harness self-test (validate against a known bug)

Before trusting this on unknowns, point it at a bug you already understand: **querying a table while its
cache is still syncing returns 0 rows** — the confirmed routing behavior that forced the `C`/`D` merge.

Add a temporary L2 assertion that `QueryTable` returns >0 rows for a table known to have data. A correct
harness will find the violating sequence (`CreateCache` → `QueryTable` before settle) and shrink it to
those two commands. If it doesn't, the harness is broken, not the API.

Remove or downgrade that assertion afterward — it's a known bug, not something to keep red.

## Cost

With `transfers` (2.5s syncs) and walks of 6–10 commands: roughly 30–60s per walk, so ~10 walks in 5–10
minutes. That's a separate-command / scheduled-run cost, not a per-push one.

## What this cannot do

- **Concurrency.** `fc.commands` generates *sequential* walks. The `C`/`D` race — two operations overlapping
  in time — is outside what this expresses. `HANDOFF.md` §9 already concluded a hand-picked conflict matrix
  beats randomization for concurrent combinations, and that reasoning still stands.
- **Correctness of data.** The 100-row cap needs an oracle that knows the real row count. Different problem.
- **Regression.** Same limitation as any generated suite: good at *discovery*, weak at *regression*. The
  pattern is to let it find things, then write a named deterministic test for each finding — which is
  exactly what already happened by hand with the cap and the cache hangs.

## Open questions

- Does `DeleteCache` on a `RUNNING` cache succeed, block, or error? Genuinely unknown, and one of the more
  likely places to find something.
- Do `incrementalUpdate` and `fullRefreshUpdate` queue, reject, or clobber each other when overlapping?
- Is `NOT_INITIALIZED` reachable in practice, or only a schema artifact? Never observed in any run so far.
