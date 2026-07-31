const { assertStatus } = require("./assert");
const { mostRecentExecution, effectiveStatus, isSettled } = require("./cacheExecution");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls a cache's status until it reaches a terminal state (success or
 * failure), or gives up after maxAttempts. Throws on failure/timeout;
 * resolves (returns nothing meaningful) on success.
 *
 * Shared so anything needing to wait for a cache to finish syncing uses the
 * exact same status-parsing logic - C polls four caches through it at once
 * (see tests/stripe/c-data-and-cache.js) - in
 * particular, the "terminal status matched exactly against the relevant
 * field, not a substring search of the whole response" fix, since the raw
 * response always contains a literal "error": null field even while happily
 * RUNNING, which a naive substring check would false-trigger on.
 *
 * @param {object} ctx - must have ctx.client (PeakaClient)
 * @param {string} cacheId
 * @param {object} [options]
 * @param {number} [options.maxAttempts=20]
 * @param {number} [options.delayMs=5000]
 */
async function pollCacheUntilComplete(ctx, cacheId, options = {}) {
  const maxAttempts = options.maxAttempts || 20;
  const delayMs = options.delayMs || 5000; // up to ~100s total by default

  // Exactly Peaka's documented CacheStatus enum - NOT_INITIALIZED, RUNNING,
  // COMPLETED, FAILED, CANCELLED, DELETED. NOT_INITIALIZED and RUNNING are
  // the non-terminal ones, so they fall through and keep polling.
  //
  // CANCELLED and DELETED were missing here originally, which meant a cache
  // in either state got polled all 20 attempts and then reported the generic
  // "did not reach a completed state after ~100s" timeout instead of naming
  // what actually happened. Earlier versions of both sets also listed values
  // the API never returns (SUCCEEDED, DONE, ERRORED, ...) - harmless, but
  // they implied a looser contract than Peaka actually has.
  const SUCCESS_STATUSES = new Set(["COMPLETED"]);
  const FAILURE_STATUSES = new Set(["FAILED", "CANCELLED", "DELETED"]);

  let lastBody = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await ctx.client.getCacheStatus(cacheId);
    // 404 here means "cache not found for this cacheId" (Peaka's documented
    // response), which is a real error - we just created this cache. This
    // used to be swallowed as {skipped:true} back when the endpoint path
    // itself was unverified and a 404 might have meant "wrong path"; the
    // path is confirmed now, so a 404 gets to fail like any other bad status.
    assertStatus(res, 200, "getCacheStatus");
    lastBody = res.body;

    // Reads the MOST RECENT execution record - see helpers/cacheExecution.js.
    // This used to be `incremental || fullRefresh`, which made every full
    // refresh invisible behind a stale COMPLETED incremental and let this
    // function return without waiting for anything at all.
    const execution = mostRecentExecution(res.body);
    const status = effectiveStatus(res.body);

    // isSettled() also requires the TOP-LEVEL status to be terminal, which
    // covers the ~300ms after triggerFullRefresh where the new execution
    // record does not exist yet and only the stale incremental one is visible.
    if (SUCCESS_STATUSES.has(status) && isSettled(res.body)) {
      return;
    }
    if (FAILURE_STATUSES.has(status)) {
      // execution.error is an object in Peaka's schema, so stringify it -
      // interpolating it directly just prints "[object Object]".
      const rawError = execution && execution.error;
      const errorDetail = rawError ? JSON.stringify(rawError) : "no error detail provided";
      throw new Error(`Cache sync reported failure (status=${status}): ${errorDetail}`);
    }
    // Non-terminal (NOT_INITIALIZED, RUNNING) - keep polling.
    await sleep(delayMs);
  }

  throw new Error(
    `Cache did not reach a completed state after ${maxAttempts} attempts (~${
      (maxAttempts * delayMs) / 1000
    }s). Last response: ${JSON.stringify(lastBody)}`
  );
}

module.exports = { pollCacheUntilComplete };
