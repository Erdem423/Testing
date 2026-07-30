const { AsyncLocalStorage } = require("async_hooks");

/**
 * Live per-step reporting channel.
 *
 * WHY HTTP AND NOT THE SHARED EVENT BUS
 * jest/reporterBus.js works for jest/browserReporter.js because Jest loads
 * reporters itself, in the host process, through plain Node require - so the
 * reporter and server.js genuinely share one module instance.
 *
 * Test files do NOT get that. Everything a test requires goes through
 * jest-runtime's own sandboxed module registry, so `require("../reporterBus")`
 * from inside a test returns a DIFFERENT EventEmitter that server.js never
 * sees. And since scenarios G-N each live in their own file, Jest may run them
 * in separate worker *processes* as well, where sharing a module instance is
 * impossible by construction.
 *
 * A localhost HTTP callback sidesteps both problems: server.js sets
 * PEAKA_STEP_REPORT_URL before invoking Jest, and this module POSTs each step
 * event there. With the variable unset - i.e. a plain `npm test` - every emit
 * is a no-op, so the CLI behaves exactly as before.
 *
 * WHY AsyncLocalStorage FOR THE SCENARIO NAME
 * step() needs to know which scenario it belongs to. A module-level "current
 * scenario" variable would be wrong for jest/stripe/connector.test.js, where
 * four test.concurrent() blocks interleave inside one process - their steps
 * would overwrite each other's context. AsyncLocalStorage keeps a separate
 * store per async execution context, which is exactly the shape of the
 * problem.
 */
const storage = new AsyncLocalStorage();

/** Runs `fn` with `scenario` attached to every step() call inside it. */
function withScenario(scenario, fn) {
  return storage.run({ scenario, index: 0 }, fn);
}

function currentStore() {
  return storage.getStore() || null;
}

/**
 * Fire-and-forget POST of one step event. Awaited (not detached) so events
 * arrive in the order they happened - it's localhost, so the cost is well
 * under a millisecond against steps that take seconds.
 *
 * Every failure is swallowed on purpose: reporting must never be able to fail
 * a test. A dashboard that missed an event is a cosmetic problem; a test that
 * failed because the dashboard was down is a real one.
 */
async function emit(event) {
  const url = process.env.PEAKA_STEP_REPORT_URL;
  if (!url) return; // plain `npm test` - nothing listening, nothing to do
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (_) {
    // deliberately ignored - see above
  }
}

module.exports = { withScenario, currentStore, emit };
