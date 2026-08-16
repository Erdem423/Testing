/**
 * Custom Jest reporter - streams live results to the dashboard over HTTP
 * (POSTing to PEAKA_STEP_REPORT_URL) instead of writing to a file (like
 * jest-junit) or the terminal (like the default reporter). server.js's
 * /api/step-event endpoint routes whatever arrives here to the matching
 * run's SSE stream, which forwards it to the browser.
 *
 * Jest instantiates this class itself (`new BrowserStreamReporter(...)`) as
 * part of running the suite - we never construct it ourselves.
 *
 * WHY HTTP AND NOT A SHARED IN-PROCESS EVENT BUS: this reporter runs inside
 * a Jest process that server.js forks (see jest/runInChild.js), not in
 * server.js's own process - a forked child has its own separate memory, so a
 * shared module singleton could never be the SAME object on both ends. This
 * mirrors the reasoning already documented in helpers/stepReporter.js for
 * why per-step events go over HTTP; the same applies to whole-test-result
 * events, for the same underlying reason (different process).
 *
 * The URL carries a runId query parameter, minted per run by server.js. That
 * is what keeps CONCURRENT runs apart: several connectors can be running at
 * once, and without the tag there would be no way to tell which run's stream
 * a given result belonged to.
 *
 * With PEAKA_STEP_REPORT_URL unset - i.e. a plain `npm test` - every post()
 * is a no-op, so the CLI behaves exactly as before.
 *
 * Hooks used:
 *   onRunStart       - fires once, right before any tests run
 *   onTestCaseResult - fires once per test that actually EXECUTES (status
 *                      "passed" or "failed"), as soon as THAT test finishes -
 *                      even though all 5 tests here are test.concurrent() in
 *                      one file, Jest still reports each one back as it
 *                      completes, not all at once.
 *   onTestFileResult - fires once per FILE, after every test in it is done.
 *   onRunComplete    - fires once, after everything is done
 *
 * NOTE: Jest's reporter API doesn't expose a "this test is now starting"
 * hook at the individual test-case level - so this reporter can't emit a
 * "running" event for an individual test the way a hand-rolled runner could.
 *
 * onTestCaseResult NEVER FIRES FOR A PENDING/SKIPPED TEST - confirmed live
 * 2026-08-14 by instrumenting both hooks: a file whose sole test is
 * `test.skip(...)` (which is what every gated-off scenario in this suite is)
 * produces zero onTestCaseResult calls, but a correct onTestFileResult with
 * that test's real name and status "pending" inside its testResults array.
 * This is standard Jest reporter behaviour, not a bug in gatedTest() or in
 * this file's own logic - onTestCaseResult is documented as covering tests
 * that ran; pending ones only ever appear in the aggregate per-file results.
 *
 * The consequence, before onTestFileResult was added below: a scenario gated
 * off for missing data never sent ANY event to the browser - not a skip, not
 * anything. The dashboard rendered it from the static meta.js list as a
 * spinner and NOTHING ever arrived to move it out of that state, for the rest
 * of that run. Restarting the dashboard did not help, because the bug was
 * never about stale state - it was about an event that was never going to be
 * sent at all.
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

/**
 * Builds the "result" event for one test case. Shared by both hooks below so
 * they cannot drift - onTestFileResult reports exactly the same shape for a
 * pending test that onTestCaseResult reports for one that ran.
 */
function buildResultEvent(raw) {
  // THREE outcomes, not two. A skipped test used to fall into the `FAIL`
  // branch, so a scenario gated off by helpers/preflight.js's gatedTest()
  // (missing/placeholder credentials, or insufficient seeded data) showed
  // up in the dashboard as a red failure. It is not a failure - it did not
  // run - and conflating the two is exactly what makes a partial run hard
  // to read.
  const status = raw.status === "passed" ? "PASS" : raw.status === "pending" || raw.status === "skipped" ? "SKIP" : "FAIL";

  // helpers/preflight.js appends "[SKIPPED: <reason>]" to the test name so
  // the reason survives across process boundaries (this reporter runs in a
  // forked child - see the module comment above). Strip it back off here
  // so the name still matches the scenario declared in meta.js, and send
  // the reason as its own field.
  const fullName = raw.fullName || raw.title || "";
  const marker = fullName.indexOf(SKIP_MARKER);
  const name = marker === -1 ? fullName : fullName.slice(0, marker).trim();
  const skipReason = marker === -1 ? null : fullName.slice(marker + SKIP_MARKER.length).replace(/\]$/, "");

  return {
    type: "result",
    name,
    status,
    skipReason,
    duration: raw.duration,
    failureMessages: raw.failureMessages || [],
  };
}

class BrowserStreamReporter {
  async onRunStart() {
    await post({ type: "run-start" });
  }

  async onTestCaseResult(test, testCaseResult) {
    await post(buildResultEvent(testCaseResult));
  }

  /**
   * Catches every result onTestCaseResult could never have reported - see the
   * module comment for why pending/skipped tests never reach that hook at all.
   * "passed" and "failed" are skipped explicitly here because they already
   * went out live above, the instant each one finished; re-posting them would
   * double-report. Awaited in sequence rather than Promise.all so the events
   * reach the browser in a stable order.
   */
  async onTestFileResult(test, testResult) {
    for (const tc of testResult.testResults) {
      if (tc.status === "passed" || tc.status === "failed") continue;
      await post(buildResultEvent(tc));
    }
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
