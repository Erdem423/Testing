/**
 * Reading a cache's *current* status from getCacheStatus.
 *
 * Extracted because two files had independently written the same wrong line:
 *
 *     lastIncrementalCacheExecution || lastFullRefreshCacheExecution
 *
 * That precedence is a bug. The two records are independent slots, not a
 * fallback chain - once an incremental has run, its record stays populated
 * forever, so `||` returns it for the rest of the cache's life and every
 * subsequent FULL REFRESH is invisible. Measured 1.5s into a full refresh:
 *
 *     top-level status : RUNNING
 *     incremental      : COMPLETED   <- stale, from the previous incremental
 *     fullRefresh      : RUNNING     <- the operation actually in flight
 *
 * Anything waiting for "the cache to finish" therefore returned INSTANTLY on
 * the stale COMPLETED. That is not theoretical: it is why M's full-refresh
 * cancel step kept flipping between 200 and 404. The step believed it had
 * settled the cache first, so it thought it was testing the idle path, while
 * it was really cancelling a refresh that was still running - the exact race
 * the step had just been rewritten to eliminate. It even produced a plausible
 * wrong conclusion (that the two cancel endpoints disagree about idle caches)
 * before the shadowing was spotted. Both return 404 when genuinely idle.
 *
 * Each record carries createdAt/updatedAt/finishedAt, so "most recent" is
 * decidable rather than guessable.
 */

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED", "DELETED"];

/**
 * The execution record that reflects what the cache is doing NOW: whichever of
 * the two slots was created most recently. Returns null if neither exists.
 */
function mostRecentExecution(body) {
  const candidates = [body.lastIncrementalCacheExecution, body.lastFullRefreshCacheExecution].filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.reduce((newest, current) =>
    new Date(current.createdAt || 0) > new Date(newest.createdAt || 0) ? current : newest
  );
}

/**
 * The effective status of a cache, as a single upper-cased string.
 *
 * Takes the most recent execution record, falling back to the top-level status
 * when no execution has ever run.
 */
function effectiveStatus(body) {
  const execution = mostRecentExecution(body);
  return String((execution && execution.status) || body.status || "").toUpperCase();
}

/**
 * Whether a cache is genuinely idle - nothing in flight.
 *
 * Requires the TOP-LEVEL status to be terminal as well as the latest record's,
 * which closes the remaining gap: a full refresh's execution record is created
 * ~300ms AFTER triggerFullRefresh returns 200, and in that window the only
 * record present is the stale incremental one. The top-level status flips to
 * RUNNING first, so checking both means a just-triggered refresh is never
 * mistaken for a settled cache.
 */
function isSettled(body) {
  const topLevel = String(body.status || "").toUpperCase();
  return TERMINAL.includes(topLevel) && TERMINAL.includes(effectiveStatus(body));
}

module.exports = { mostRecentExecution, effectiveStatus, isSettled, TERMINAL };
