const { assertStatusIn } = require("./assert");

/**
 * Waits for a materialized query to reach a terminal state - and, when asked,
 * for a genuinely NEW execution to have begun.
 *
 * THE TIMESTAMP ARGUMENT IS THE WHOLE POINT. The status endpoint serves the
 * PREVIOUS terminal value until a new run starts, so a status-only poll is
 * satisfied instantly by a stale reading and the caller believes a refresh ran
 * when it did not. That has bitten this repo twice:
 *
 *   - a Tier 1 race step reported "entered window: false" on every run because
 *     it gave up before the refresh began (see FINDINGS, "a race test that
 *     passed without ever racing")
 *   - materialized-never-stale.js originally asserted lastExecutionStartTime
 *     was null before its first refresh, which was a RACE: null when written,
 *     a real timestamp on a later run, failing a green scenario for a reason
 *     that had nothing to do with Peaka
 *
 * Passing `priorExecutionStart` makes the wait key on the timestamp moving
 * rather than on a status that may never have changed.
 *
 * ONLY THE PEAKA-TABLES CALLER WAS MIGRATED - see the note in
 * helpers/pollExport.js for why the postgres and races copies were left alone.
 */
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} client a PeakaClient
 * @param {string} queryId the materialized query's id
 * @param {object} [opts] { label, priorExecutionStart, intervalMs, maxAttempts }
 *   priorExecutionStart: when supplied, the poll additionally waits until
 *   lastExecutionStartTime differs from it. Pass `undefined` to accept any
 *   terminal status.
 * @returns {Promise<object>} the final status body
 */
async function pollMaterialized(client, queryId, opts = {}) {
  const label = opts.label || "materialized query";
  const intervalMs = opts.intervalMs || 1500;
  const maxAttempts = opts.maxAttempts || 40;
  const prior = opts.priorExecutionStart;

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await client.getMaterializedQueryStatus(queryId);
    assertStatusIn(res, [200], `getMaterializedQueryStatus (${label})`);
    last = res.body;
    const terminal = TERMINAL.includes(String(res.body.status).toUpperCase());
    const moved = prior === undefined || res.body.lastExecutionStartTime !== prior;
    if (terminal && moved) return last;
    await sleep(intervalMs);
  }

  throw new Error(
    `Materialized query never reached a terminal state${prior === undefined ? "" : " with a NEW execution"} ` +
      `during '${label}' after ${maxAttempts} attempts. Last: ${JSON.stringify(last)}`
  );
}

module.exports = { pollMaterialized, MATERIALIZED_TERMINAL: TERMINAL };
