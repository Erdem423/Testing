/**
 * Custom Jest reporter - streams live results to the dashboard over HTTP
 * (POSTing to PEAKA_STEP_REPORT_URL) instead of writing to a file (like
 * jest-junit) or the terminal (like the default reporter). server.js's
 * /api/step-event endpoint re-emits whatever arrives here onto
 * jest/reporterBus.js, which the SSE handler forwards to the browser.
 *
 * Jest instantiates this class itself (`new BrowserStreamReporter(...)`) as
 * part of running the suite - we never construct it ourselves.
 *
 * WHY HTTP AND NOT A SHARED IN-PROCESS EVENT BUS: this reporter now runs
 * inside a Jest process that server.js forks (see jest/runInChild.js), not
 * in server.js's own process - a forked child has its own separate memory,
 * so a shared module singleton (jest/reporterBus.js) would no longer be the
 * SAME object on both ends. This mirrors exactly the reasoning already
 * documented in helpers/stepReporter.js for why per-step events go over HTTP
 * rather than the bus directly - now the same reasoning applies to whole-
 * test-result events too, for the same underlying reason (different
 * process), not because it stopped working for a different reason.
 *
 * With PEAKA_STEP_REPORT_URL unset - i.e. a plain `npm test` - every post()
 * is a no-op, so the CLI behaves exactly as before.
 *
 * Hooks used:
 *   onRunStart       - fires once, right before any tests run
 *   onTestCaseResult - fires once per individual test, as soon as THAT test
 *                      finishes - even though all 5 tests here are
 *                      test.concurrent() in one file, Jest still reports
 *                      each one back as it completes, not all at once.
 *   onRunComplete    - fires once, after everything is done
 *
 * NOTE: Jest's reporter API doesn't expose a "this test is now starting"
 * hook at the individual test-case level - so this reporter can't emit a
 * "running" event for an individual test the way a hand-rolled runner could.
 */
const { SKIP_MARKER } = require("../helpers/preflight");

/** Fire-and-await POST of one event - swallows every failure on purpose, same as helpers/stepReporter.js: a dashboard that missed an event is cosmetic, a test that failed because the dashboard was unreachable is not. */
async function post(event) {
  const url = process.env.PEAKA_STEP_REPORT_URL;
  if (!url) return;
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

class BrowserStreamReporter {
  async onRunStart() {
    await post({ type: "run-start" });
  }

  async onTestCaseResult(test, testCaseResult) {
    // THREE outcomes, not two. A skipped test used to fall into the `FAIL`
    // branch, so a scenario gated off by helpers/preflight.js's gatedTest()
    // (missing/placeholder credentials, or insufficient seeded data) showed
    // up in the dashboard as a red failure. It is not a failure - it did not
    // run - and conflating the two is exactly what makes a partial run hard
    // to read.
    const raw = testCaseResult.status;
    const status = raw === "passed" ? "PASS" : raw === "pending" || raw === "skipped" ? "SKIP" : "FAIL";

    // helpers/preflight.js appends "[SKIPPED: <reason>]" to the test name so
    // the reason survives across process boundaries (this reporter runs in a
    // forked child - see the module comment above). Strip it back off here
    // so the name still matches the scenario declared in meta.js, and send
    // the reason as its own field.
    const fullName = testCaseResult.fullName || testCaseResult.title || "";
    const marker = fullName.indexOf(SKIP_MARKER);
    const name = marker === -1 ? fullName : fullName.slice(0, marker).trim();
    const skipReason = marker === -1 ? null : fullName.slice(marker + SKIP_MARKER.length).replace(/\]$/, "");

    await post({
      type: "result",
      name,
      status,
      skipReason,
      duration: testCaseResult.duration,
      failureMessages: testCaseResult.failureMessages || [],
    });
  }

  async onRunComplete(contexts, results) {
    await post({
      type: "done",
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      skipped: results.numPendingTests,
      total: results.numTotalTests,
    });
  }
}

module.exports = BrowserStreamReporter;
