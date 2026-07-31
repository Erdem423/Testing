/**
 * Timing primitives for deliberately racing operations against each other.
 *
 * Two distinct patterns, and conflating them is the main way this gets built
 * wrong (see CONCURRENCY-SPEC.md):
 *
 *   duringSync()     - "do X while Y is running". Enters the window
 *                      deterministically by POLLING until the slow operation
 *                      actually reports RUNNING, rather than sleeping and
 *                      hoping. Measured: a cache on `customers` reports
 *                      RUNNING ~2s after createCache returns, and stays there
 *                      ~30s, so the window is comfortable.
 *
 *   simultaneously() - symmetric races, where neither side is "the slow one".
 *                      Uses allSettled, never all: one call rejecting must not
 *                      hide what the other returned, since the whole point is
 *                      to compare both outcomes.
 */

const { effectiveStatus, isSettled, TERMINAL } = require("./cacheExecution");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads a cache's current status.
 *
 * Delegates to helpers/cacheExecution.js, which picks the most RECENT execution
 * record. This file used to prefer the incremental one unconditionally, so a
 * full refresh raced here was shadowed by a stale COMPLETED and every
 * "did it settle?" check passed without waiting.
 */
async function readCacheStatus(ctx, cacheId) {
  const res = await ctx.client.getCacheStatus(cacheId);
  if (res.status !== 200) return { status: `HTTP_${res.status}`, body: res.body };
  return { status: effectiveStatus(res.body), body: res.body, settled: isSettled(res.body) };
}

/**
 * Generic form: polls `readStatus` until `isTarget(status)` holds, then invokes
 * `conflictFn` inside that window.
 *
 * Deliberately does NOT throw if the window is missed - an operation that
 * finishes before we get inside it is a legitimate outcome, not a test
 * failure. The caller gets `enteredWindow: false` and should assert invariants
 * only. A test that goes red because a race didn't happen trains people to
 * ignore red.
 *
 * `isDone` lets the poll give up early once the operation has clearly finished,
 * rather than burning the whole timeout.
 *
 * @returns {Promise<{enteredWindow: boolean, statusAtFire: string, msToWindow: number|null, result: any}>}
 */
async function duringState(readStatus, isTarget, conflictFn, { pollMs = 250, maxWaitMs = 20000, isDone } = {}) {
  const startedAt = Date.now();
  let statusAtFire = null;
  let msToWindow = null;

  while (Date.now() - startedAt < maxWaitMs) {
    statusAtFire = await readStatus();
    if (isTarget(statusAtFire)) {
      msToWindow = Date.now() - startedAt;
      break;
    }
    if (isDone ? isDone(statusAtFire) : TERMINAL.includes(statusAtFire)) break;
    await sleep(pollMs);
  }

  const enteredWindow = isTarget(statusAtFire);
  const result = await conflictFn();
  return { enteredWindow, statusAtFire, msToWindow, result };
}

/**
 * Cache-specific wrapper: fires `conflictFn` while the cache is RUNNING.
 * Measured: a cache on `customers` reports RUNNING ~2s after createCache
 * returns and stays there ~30s, so the window is comfortable.
 */
async function duringSync(ctx, cacheId, conflictFn, opts = {}) {
  const out = await duringState(
    async () => (await readCacheStatus(ctx, cacheId)).status,
    (s) => s === "RUNNING",
    conflictFn,
    opts
  );
  return { ...out, msToRunning: out.msToWindow };
}

/**
 * Export-specific wrapper: fires `conflictFn` while an export job is still
 * PENDING or RUNNING. Export jobs on small result sets finish in a few
 * seconds, so the window is much tighter than a cache sync - hence the faster
 * default poll.
 */
async function duringExport(ctx, exportId, conflictFn, opts = {}) {
  const EXPORT_TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "CANCELED", "EXPIRED"];
  return duringState(
    async () => {
      const res = await ctx.client.getExport(exportId);
      return res.status === 200 ? String(res.body.status).toUpperCase() : `HTTP_${res.status}`;
    },
    (s) => s === "PENDING" || s === "RUNNING",
    conflictFn,
    { pollMs: 150, maxWaitMs: 15000, isDone: (s) => EXPORT_TERMINAL.includes(s), ...opts }
  );
}

/**
 * Fires several operations at once and returns every outcome, including
 * rejections. Order of results matches order of input.
 */
async function simultaneously(fns) {
  const settled = await Promise.allSettled(fns.map((fn) => fn()));
  return settled.map((s) => (s.status === "fulfilled" ? { ok: true, value: s.value } : { ok: false, error: s.reason }));
}

/**
 * Waits for a cache to reach any terminal state. Unlike
 * pollCacheUntilComplete, it does NOT treat CANCELLED/FAILED as an error -
 * these tests deliberately produce those states, and what matters is that the
 * resource settles at all rather than wedging forever.
 */
async function waitForSettled(ctx, cacheId, { pollMs = 3000, maxAttempts = 40 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await readCacheStatus(ctx, cacheId);
    // `last.settled` requires the top-level status to be terminal too, so a
    // refresh triggered moments ago - whose execution record has not been
    // created yet - is not mistaken for a finished one.
    if (last.settled) return { settled: true, status: last.status };
    await sleep(pollMs);
  }
  return { settled: false, status: last && last.status };
}

module.exports = {
  duringState,
  duringSync,
  duringExport,
  simultaneously,
  waitForSettled,
  readCacheStatus,
  sleep,
  TERMINAL,
};
