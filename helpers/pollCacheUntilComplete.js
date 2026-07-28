const { assertStatus } = require("./assert");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls a cache's status until it reaches a terminal state (success or
 * failure), or gives up after maxAttempts. Throws on failure/timeout;
 * resolves (returns nothing meaningful) on success.
 *
 * Extracted from tests/stripe/d-cache-behavior.js so any test needing to
 * wait for a cache to finish syncing (D's own check, or C's cache-vs-live
 * count comparison) uses the exact same status-parsing logic - in
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
 * @returns {Promise<{ skipped: boolean }>} - skipped:true if getCacheStatus
 *   returned 404 (best-effort endpoint path, see peakaClient.js header) -
 *   callers should treat this as "couldn't verify, not necessarily broken"
 */
async function pollCacheUntilComplete(ctx, cacheId, options = {}) {
  const maxAttempts = options.maxAttempts || 20;
  const delayMs = options.delayMs || 5000; // up to ~100s total by default

  const SUCCESS_STATUSES = new Set(["SUCCESS", "SUCCEEDED", "COMPLETED", "DONE", "FINISHED"]);
  const FAILURE_STATUSES = new Set(["FAILED", "FAILURE", "ERROR", "ERRORED"]);

  let lastBody = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await ctx.client.getCacheStatus(cacheId);
    if (res.status === 404) {
      return { skipped: true };
    }
    assertStatus(res, 200, "getCacheStatus");
    lastBody = res.body;

    // Prefer the most specific execution status available, fall back to
    // the top-level cache status.
    const execution = res.body.lastIncrementalCacheExecution || res.body.lastFullRefreshCacheExecution;
    const rawStatus = (execution && execution.status) || res.body.status;
    const status = (rawStatus || "").toUpperCase();

    if (SUCCESS_STATUSES.has(status)) {
      return { skipped: false };
    }
    if (FAILURE_STATUSES.has(status)) {
      const errorDetail = (execution && execution.error) || "no error detail provided";
      throw new Error(`Cache sync reported failure (status=${status}): ${errorDetail}`);
    }
    // Anything else (RUNNING, PENDING, QUEUED, etc.) - keep polling.
    await sleep(delayMs);
  }

  throw new Error(
    `Cache did not reach a completed state after ${maxAttempts} attempts (~${
      (maxAttempts * delayMs) / 1000
    }s). Last response: ${JSON.stringify(lastBody)}`
  );
}

module.exports = { pollCacheUntilComplete };
