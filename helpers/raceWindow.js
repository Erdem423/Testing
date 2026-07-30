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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED", "DELETED"];

/** Reads the most specific status available for a cache. */
async function readCacheStatus(ctx, cacheId) {
  const res = await ctx.client.getCacheStatus(cacheId);
  if (res.status !== 200) return { status: `HTTP_${res.status}`, body: res.body };
  const exec = res.body.lastIncrementalCacheExecution || res.body.lastFullRefreshCacheExecution;
  return { status: String((exec && exec.status) || res.body.status).toUpperCase(), body: res.body };
}

/**
 * Polls until the cache reports RUNNING, then invokes `conflictFn` inside that
 * window.
 *
 * Deliberately does NOT throw if the window is missed - a sync that finishes
 * before we get inside it is a legitimate outcome, not a test failure. The
 * caller gets `enteredWindow: false` and should assert invariants only. A test
 * that goes red because a race didn't happen trains people to ignore red.
 *
 * @returns {Promise<{enteredWindow: boolean, statusAtFire: string, msToRunning: number|null, result: any}>}
 */
async function duringSync(ctx, cacheId, conflictFn, { pollMs = 250, maxWaitMs = 20000 } = {}) {
  const startedAt = Date.now();
  let statusAtFire = null;
  let msToRunning = null;

  while (Date.now() - startedAt < maxWaitMs) {
    const { status } = await readCacheStatus(ctx, cacheId);
    statusAtFire = status;
    if (status === "RUNNING") {
      msToRunning = Date.now() - startedAt;
      break;
    }
    if (TERMINAL.includes(status)) break; // finished before we got in
    await sleep(pollMs);
  }

  const enteredWindow = statusAtFire === "RUNNING";
  const result = await conflictFn();
  return { enteredWindow, statusAtFire, msToRunning, result };
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
    if (TERMINAL.includes(last.status)) return { settled: true, status: last.status };
    await sleep(pollMs);
  }
  return { settled: false, status: last && last.status };
}

module.exports = { duringSync, simultaneously, waitForSettled, readCacheStatus, sleep, TERMINAL };
