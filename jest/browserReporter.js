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

class BrowserStreamReporter {
  onRunStart() {
    bus.emit("event", { type: "run-start" });
  }

  onTestCaseResult(test, testCaseResult) {
    const status = testCaseResult.status === "passed" ? "PASS" : "FAIL";
    bus.emit("event", {
      type: "result",
      name: testCaseResult.fullName || testCaseResult.title,
      status,
      duration: testCaseResult.duration,
      failureMessages: testCaseResult.failureMessages || [],
    });
  }

  onRunComplete(contexts, results) {
    bus.emit("event", {
      type: "done",
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      total: results.numTotalTests,
    });
  }
}

module.exports = BrowserStreamReporter;
