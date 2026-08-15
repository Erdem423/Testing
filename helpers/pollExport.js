const { assertStatusIn } = require("./assert");

/**
 * Polls an export job until it reaches a terminal state.
 *
 * WHY THIS EXISTS. The same ~20-line loop had been copy-pasted into
 * tests/peaka-tables/export-round-trip.js, tests/postgres/pg-c-exports.js and
 * tests/races/tier4.js before a fourth caller made it worth extracting.
 * helpers/pollCacheUntilComplete.js is the precedent for pulling this shape of
 * loop out of the scenarios.
 *
 * ONLY THE PEAKA-TABLES CALLERS WERE MIGRATED. The Postgres and races copies
 * still have their own inline versions, deliberately: verifying a change to
 * the race tiers needs Stripe credentials and roughly ten minutes, and quietly
 * rewriting code that cannot be cheaply re-run is how a refactor breaks
 * something nobody notices for weeks. They can move here whenever someone is
 * running those folders anyway.
 *
 * Exports are the flakiest thing this suite touches - FINDINGS records them
 * failing intermittently with no race involved - so a timeout here is worth
 * re-running once before being believed, which the thrown message says.
 */
const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} client   a PeakaClient
 * @param {string} exportId the job id returned by createTableExport/createQueryExport
 * @param {object} [opts]   { label, intervalMs, maxAttempts }
 * @returns {Promise<object>} the final job body
 */
async function pollExport(client, exportId, opts = {}) {
  const label = opts.label || "export";
  const intervalMs = opts.intervalMs || 2000;
  const maxAttempts = opts.maxAttempts || 40;

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await client.getExport(exportId);
    assertStatusIn(res, [200], `getExport (${label})`);
    last = res.body;
    if (TERMINAL.includes(String(res.body.status).toUpperCase())) return last;
    await sleep(intervalMs);
  }

  throw new Error(
    `The export did not reach a terminal state during '${label}' after ${maxAttempts} attempts ` +
      `(~${(maxAttempts * intervalMs) / 1000}s). Exports fail intermittently in this API with no race ` +
      `involved, so re-run once before treating this as a regression. Last: ${JSON.stringify(last)}`
  );
}

module.exports = { pollExport, EXPORT_TERMINAL: TERMINAL };
