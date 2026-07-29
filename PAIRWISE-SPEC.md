# Spec — generated query-surface coverage (pairwise)

Proposal, not implemented. Replaces the unused model in `model.txt`.

## Why a different model

`model.txt` currently models `Table × CacheSchedule × QueryFormat × QueryMechanism`. Two of those four
dimensions don't belong:

- **`Table` is a fixture, not a config knob.** A serialization or pagination bug shows up on any table,
  so testing each table once gives the same signal as testing every pair. It inflates the space without
  adding interaction coverage.
- **`CacheSchedule` is expensive *and* unobservable.** Each value costs a cache create + sync (~40s), and
  a schedule is an ISO-8601 duration (`PT6H`) whose firing can't be observed inside a test run. The only
  assertable thing is that the config echoes back — three assertions, not twenty-one cache creations.

Strip those out and the remaining space is too small to need minimizing. So the old model gets pairwise
economics exactly backwards: minimization only pays on the dimension that can't be asserted on.

The **query request shape** is the space that actually justifies generation. It's currently at zero
coverage — every `executeQuery` call in the suite passes `"SIMPLE"` and a raw statement, so `CELL_TYPED`
(Peaka's documented default), `COMPACT`, and the entire builder request type have never been exercised.

### Honest revision: the interaction argument got weaker

An earlier draft of this spec justified the model by claiming the filtered-count finding (refunded charges,
18 live vs 85 cached) was a `filter × pagination` **interaction** — a bug living in exactly this space,
found by accident from another direction. That was the strongest argument for generating combinations here.

Direct measurement since then shows it isn't an interaction at all. *Every* live read caps at 100 rows —
`SELECT ... LIMIT 500` returns 100, same as `COUNT(*)`. There is one truncation, at the scan, and the
filter, the aggregate and the row fetch are three symptoms of it. Nothing about combining filter *with*
pagination produces behavior that either produces alone.

So the honest position: **no confirmed interaction bug has been found in this project.** All five known
findings are single-dimension or sequential. `offset × orderBy` (unstable pages without deterministic
ordering) remains a well-known bug class and is plausible here, but it is unproven.

What survives as justification is narrower than "pairwise finds interaction bugs":

- `CELL_TYPED` and `COMPACT` have literally never been called, nor has the builder request type. That's a
  real untested surface regardless of how it gets covered.
- The **invariants** below are valuable independent of how the cases are generated — particularly the
  differential ones, which is where the real assertions live.

That is a weaker case than this document originally made, and it's worth weighing before building: the
value is concentrated in the invariants, not in the generation. A hand-written matrix of ~10 cases would
capture most of it. Generation earns its place only if the model grows past what's readable by hand.

## Execution model — runs separately, not with `npm test`

This scenario runs under its own command rather than alongside the existing four tests. That is a
correctness decision, not just a packaging one.

**It dissolves the fixture problem.** Running concurrently, the generated queries would have to avoid every
table `C` caches (`customers`, `charges`, `subscriptions`, `invoices`), since querying a table mid-sync
returns 0 rows — the confirmed routing behavior that forced the `C`/`D` merge and pushed `F`'s pagination
off `charges`. That left only `refunds` (85 rows), which sits *under* the 100-row cap boundary and
therefore cannot exercise `limit=250` or the filter-vs-truncation invariant at all — the single assertion
that most justifies building this.

Run alone, nothing is creating caches, so `charges` (652 rows) or `customers` (505) are both available and
both clear the boundary comfortably.

Two further benefits: `npm test` stays fast (~54s) and fully green, so a failure there still means
something real; and it matches the deferred CI split — cheap deterministic suite on every push, slower
exploratory suite on its own cadence.

### The precondition this creates

The generated suite depends on reading **live, uncached** data. The cap only applies to live reads, so if a
previous main-suite run crashed or ran with `SKIP_CLEANUP=true` and left caches behind, these queries would
be served from cache, the cap wouldn't apply, and the headline invariant would pass while testing nothing.

So the first step must assert `isCached === false` on the fixture table and **fail loudly** — not skip, and
not proceed. A silently-cached fixture makes the whole scenario meaningless, which is worse than not
running it. (`C` skips in the equivalent situation because only one of its steps is invalidated; here it's
everything.)

### Mechanics

- `jest.config.js` gains `testPathIgnorePatterns` for the generated suite's directory, so `npm test` keeps
  discovering exactly the four existing tests.
- A second config (`jest.pairwise.config.js`) plus an `npm run test:pairwise` script targets only that
  directory. Note: Jest 30 renamed `--testPathPattern` to `--testPathPatterns` (plural) — a previous pair
  of scripts silently matched nothing because of this.
- For the dashboard, it can live as its own folder (`tests/<name>/meta.js` + `jest/<name>/`), which
  `server.js`'s `discoverConnectors()` picks up with **zero code changes** — that dynamic discovery was
  built and verified for exactly this. It then appears as a separate card that runs independently of the
  Stripe folder, which is also what keeps it from running concurrently there.

## Dimensions

| Dimension | Values | Notes |
|---|---|---|
| `Mechanism` | `statement`, `builder` | Raw SQL vs. the `from`/`columns`/`filters` builder request |
| `Format` | `CELL_TYPED`, `SIMPLE`, `COMPACT` | All three response shapes; two currently never exercised |
| `Limit` | `absent`, `5`, `250` | `250` crosses the 100-row boundary where the cap lives |
| `Offset` | `absent`, `0`, `50` | |
| `OrderBy` | `absent`, `id ASC`, `id DESC` | |
| `Filter` | `none`, `equality`, `range` | e.g. `status = '...'` / `created > TIMESTAMP '...'` |

**2 × 3 × 3 × 3 × 3 × 3 = 486 combinations.** Exhaustive is ~10–15 min of real API calls; pairwise covers
every pair in roughly 15–20 rows, about 30s. That is where generation earns its place.

A third mechanism, `byName` (execute by qualified `catalog.schema.table`), is deliberately excluded — it
likely doesn't accept filters or ordering, which would need a model constraint (below), and `byId`
requires saved-query infrastructure that doesn't exist yet.

## Constraints — and the PICT-vs-homemade decision

If the model ever needs rules like *"`byName` cannot combine with `Filter=equality`"*, that's a PICT
constraint (`IF [Mechanism] = "byName" THEN [Filter] = "none";`).

**`helpers/pairwiseGenerate.js` cannot express constraints.** The real PICT binary can. That's the first
concrete technical reason to prefer `helpers/pictWrapper.js` over the homemade generator — until now the
two were interchangeable (18 vs 21 rows, both fully pair-covering).

The model above is deliberately constraint-free, so either generator works. If `byName` or saved-query
mechanisms get added later, switch to the PICT wrapper rather than filtering invalid rows out in JS after
the fact — post-filtering silently destroys pair coverage.

## Invariants

Every generated row is executed once; all invariants are evaluated over the collected results. Assertions
are **general properties**, not per-case expected values — that's what keeps a generated suite
maintainable.

### Per-case

| Invariant | Check |
|---|---|
| No server errors | Never a 5xx, on any combination |
| Response is well-formed | Parses; has `columns` and `data` |
| Limit is respected | If `Limit` is set, `data.length <= limit` |
| Format shape is correct | `CELL_TYPED` → each cell an object with `name`/`dataType`/`value`; `SIMPLE` → flat object keyed by column; `COMPACT` → positional array |
| Ordering is real | If `OrderBy` is set, the returned rows are actually in that order |
| Filters are real | If `Filter` is set, **every returned row satisfies it** — currently untested anywhere; covers STRIPE-10 |
| No duplicates | No repeated `id` within one result set |

### Differential (across generated cases)

The more interesting assertions compare *pairs* of results. Pairwise emits independent rows, so these need
their own explicit pairs rather than coming out of the generator:

| Invariant | Check |
|---|---|
| Format is presentation-only | Same query in all three formats returns the same ids in the same order |
| Mechanism equivalence | `statement` and `builder` expressing the same query return the same ids |
| Offset windows don't overlap | `offset=0` and `offset=50` at the same limit share no ids |
| Truncation is visible, not silent | Any live read returning exactly 100 rows when the table has more should be asserted deliberately — `SELECT ... LIMIT 500` → 100 on a 652-row table. This is the single most valuable assertion here and **is not currently guarded anywhere** in the suite |
| Filtered results reflect the whole table | `count(filter)` vs `count(all)` filtered client-side — the 18-vs-85 case. Now understood as a symptom of the truncation above rather than a filter bug, but still worth asserting directly since it's the form a user would actually hit |

## Test structure

One scenario, `G: Query Surface (generated)`, in `tests/stripe/g-query-surface.js`.

**Steps are per-invariant, not per-generated-row.** One step per row would give ~18 unstable step names
that `meta.js` can't mirror and that change whenever the model does. Instead:

1. `generate the query matrix` — build rows from the model, log the count and the seed
2. `execute all generated queries` — run each once, collect status + body, fail only on transport errors
3. …one step per per-case invariant above…
4. …one step per differential invariant above…

Each invariant step iterates all collected results and reports **every** violation, not just the first:
`"filter invariant violated on 3 of 18 cases: PW-04, PW-09, PW-14"`. That's far more diagnosable than a
single-case failure, and it keeps `meta.js`'s step list stable.

**Case IDs.** Every generated row gets a stable id and a human-readable label:
`PW-07 · builder / COMPACT / limit=250 / offset=50 / orderBy=id DESC / filter=range`. A failure names the
exact combination without needing the generator re-run.

**Determinism is mandatory.** The seed must be pinned (`generatePairwise(params, 42)` or PICT's `/r:N`), so
`PW-07` is the same combination on every run. An unseeded generator makes failures unreproducible and the
suite look flaky — which would undermine the project's whole "a failure should mean something real" stance.

**No cleanup needed.** This scenario is read-only: no connections, catalogs, or caches created. It's the
only scenario in the suite with no `afterAll` obligation.

## Cost

~18 queries at ~1–2s each ≈ **30s** for a standalone `npm run test:pairwise`. `npm test` is unaffected and
stays at ~54s.

## Honest limitations

- **Generated tests are good at discovery, weak at regression.** "Row 14 failed" tells you less than "the
  filter is applied after truncation." The right pattern is to let this scenario *find* things, then write
  a named targeted test for each real finding — exactly what already happened by hand with the cap and the
  cache hangs.
- **Pairwise cannot model concurrency or sequencing.** It emits independent rows. The `C`/`D` race and the
  duplicate-cache ordering behavior are outside what any combinatorial generator can express.
- **Interaction-proneness is assumed, not proven,** for most of these pairs. `filter × limit` is confirmed
  real. `offset × orderBy` is a well-known bug class. The rest are plausible but speculative — if the
  scenario runs green for several weeks, that's evidence to shrink the model, not to expand it.

## Needs verification before building

- The `filters` field schema on the builder request type — **still unknown.** Four shapes probed, all 400.
  The object form (`{status: "succeeded"}`) got a distinctly better error — `"There is a problem with
  filter input"` — meaning it reached the filter parser while the array forms were rejected earlier as the
  wrong type. So it's an object with some inner structure. Needs the docs; if it can't be resolved, drop
  the `Filter` dimension and cover filtering through the `statement` mechanism instead.
- ~~Whether `orderBy` accepts `"id ASC"` as a string or a structured object.~~ **Answered: it must be an
  array.** `["id ASC"]` returns 200 and orders correctly; the bare string `"id ASC"` returns 400.
- ~~Whether a live `SELECT ... LIMIT 250` returns >100 rows.~~ **Answered: it does not.** Measured against
  `charges` (652 rows, uncached): `LIMIT 150`, `250` and `500` all return exactly 100, via both the
  statement and builder mechanisms. So the `Limit` dimension's above-100 values can't test pagination
  depth — but "a limit above 100 still yields exactly 100" becomes the regression assertion, in the same
  shape as the existing count-cap check. Fixture choice is settled: `charges` or `customers`, both already
  measured.
