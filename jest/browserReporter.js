/**
 * Custom Jest reporter - streams live results onto a shared EventEmitter
 * (jest/reporterBus.js) instead of writing to a file (like jest-junit) or
 * the terminal (like the default reporter). server.js listens on that same
 * bus and forwards events to the browser over SSE.
 *
 * Jest instantiates this class itself (`new BrowserStreamReporter(...)`) as
 * part of running the suite - we never construct it ourselves.
 *
 * WHY A SHARED BUS INSTEAD OF A CONFIG-PASSED CALLBACK: an earlier version
 * of this reporter tried to receive a live function via reporterOptions
 * (`new BrowserStreamReporter(globalConfig, { onEvent: someFunction })`),
 * passed through runCLI()'s config. That silently failed - config gets
 * JSON-serialized internally, and JSON.stringify drops function properties
 * without any error. A plain shared module (Node caches it as a singleton
 * per process) sidesteps that entirely, since both this reporter and
 * server.js run in the same process (runCLI is called with runInBand:true).
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
const bus = require("./reporterBus");
const { SKIP_MARKER } = require("../helpers/preflight");

class BrowserStreamReporter {
  onRunStart() {
    bus.emit("event", { type: "run-start" });
  }

  onTestCaseResult(test, testCaseResult) {
    // THREE outcomes, not two. A skipped test used to fall into the `: "FAIL"`
    // branch here, so a scenario gated off for missing data showed up in the
    // dashboard as a red failure. It is not a failure - it did not run - and
    // conflating the two is exactly what makes a partial run hard to read.
    const raw = testCaseResult.status;
    const status = raw === "passed" ? "PASS" : raw === "pending" || raw === "skipped" ? "SKIP" : "FAIL";

    // helpers/preflight.js appends "[SKIPPED: <reason>]" to the test name so
    // the reason survives across process boundaries. Strip it back off here so
    // the name still matches the scenario declared in meta.js, and send the
    // reason as its own field.
    const fullName = testCaseResult.fullName || testCaseResult.title || "";
    const marker = fullName.indexOf(SKIP_MARKER);
    const name = marker === -1 ? fullName : fullName.slice(0, marker).trim();
    const skipReason = marker === -1 ? null : fullName.slice(marker + SKIP_MARKER.length).replace(/\]$/, "");

    bus.emit("event", {
      type: "result",
      name,
      status,
      skipReason,
      duration: testCaseResult.duration,
      failureMessages: testCaseResult.failureMessages || [],
    });
  }

  onRunComplete(contexts, results) {
    bus.emit("event", {
      type: "done",
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      skipped: results.numPendingTests,
      total: results.numTotalTests,
    });
  }
}

module.exports = BrowserStreamReporter;
