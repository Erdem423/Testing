const fs = require("fs");
const path = require("path");
const { currentStore } = require("./stepReporter");

/**
 * Records 5xx responses so a server error is never indistinguishable from an
 * ordinary test failure - or, worse, invisible inside a passing test.
 *
 * WHY THIS EXISTS. The instructor's spec (doc2.txt rule 6) is unambiguous:
 *
 *   "5xx her zaman hatadir: Negatif senaryolar dahil hicbir adimda 500 sinifi
 *    yanit kabul edilmez; beklenen hatalar 4xx + anlamli mesajdir."
 *
 * A 500 is Peaka's catch-all fallback. It means SERVER BUG, not "the response
 * differed from what the test expected", and the two deserve different
 * treatment. Until now helpers/assert.js could not tell them apart at all: a
 * 500 and a 400 produced byte-identical failure messages, and COVERAGE.md
 * already recorded the gap - "No '5xx is always a failure' invariant. Applied
 * ad hoc rather than globally."
 *
 * TOLERATED IS NOT ACCEPTED. Two steps deliberately pass while receiving a 500
 * (see tests/stripe/m-cache-management.js and tests/races/tier1.js) because the
 * bugs are Peaka's, already documented, and outside this suite's control - and
 * a permanently-red test gets ignored, which is how real regressions hide. They
 * keep passing. What changes is that the 500 now leaves a machine-readable
 * trace instead of a console.log nobody reads.
 *
 * WHY A FILE ON DISK. The two reporting surfaces are disjoint:
 *
 *   terminal banner + coverage.json  <- jest/reporters/incompleteRun.js, which
 *                                       server.js's inline runCLI config does
 *                                       NOT include, so it is `npm test` only
 *   dashboard                        <- stepReporter's HTTP channel, which is
 *                                       a no-op unless PEAKA_STEP_REPORT_URL
 *                                       is set, so it is dashboard only
 *
 * Neither can serve the other, and Jest runs test files in separate worker
 * PROCESSES, so an in-memory collector cannot reach the host-process reporter.
 * A sidecar file is the only carrier that works for the terminal surface. The
 * dashboard gets the same records piggybacked onto its existing step events -
 * see helpers/step.js.
 *
 * One file per pid means a single writer per file, so there is no interleaving
 * hazard, and the concurrent tests in jest/stripe/connector.test.js serialise
 * naturally through appendFileSync.
 */

const SIDECAR_DIR = path.join(__dirname, "..", "test-results", "server-errors");

// Peaka 500s sometimes return an HTML error page. This ends up in
// coverage.json, so cap it.
const MAX_BODY_CHARS = 300;

function isServerError(response) {
  // Explicit rather than relying on `undefined >= 500` being false: a
  // transport-level failure elsewhere in this repo surfaces as a thrown error
  // with no `.status` at all.
  return !!response && typeof response.status === "number" && response.status >= 500;
}

function truncate(body) {
  let text;
  try {
    text = typeof body === "string" ? body : JSON.stringify(body);
  } catch (_) {
    text = String(body);
  }
  if (typeof text !== "string") return null;
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}...[truncated]` : text;
}

/**
 * The recording primitive. Everything else here funnels through it.
 *
 * NEVER THROWS. Writing the sidecar is reporting, and reporting must never be
 * able to fail a test - the same doctrine helpers/stepReporter.js states for
 * its HTTP emit. A test that failed because the disk was full would be a far
 * worse outcome than a warning that went unrecorded.
 */
function recordServerError({ status, label, body, tolerated = false, reason = null, context = null }) {
  const store = currentStore();
  const record = {
    at: new Date().toISOString(),
    scenario: store ? store.scenario : null,
    step: store ? store.stepName || null : null,
    label: label || null,
    status,
    tolerated: !!tolerated,
    reason: reason || (tolerated ? "(no rationale recorded)" : null),
    context: context || null,
    body: truncate(body),
  };

  // In-memory copy, read by helpers/step.js to attach warnings to the step
  // event the dashboard consumes.
  if (store) {
    if (!store.serverErrors) store.serverErrors = [];
    store.serverErrors.push(record);
  }

  try {
    fs.mkdirSync(SIDECAR_DIR, { recursive: true });
    fs.appendFileSync(path.join(SIDECAR_DIR, `${process.pid}.jsonl`), `${JSON.stringify(record)}\n`);
  } catch (_) {
    // Deliberately swallowed - see the note above.
  }

  return record;
}

/**
 * Records a 5xx without asserting anything about the status.
 *
 * For the handful of steps that deliberately provoke a known server error and
 * assert only on its consequences - tests/races/tier1.js's duplicate
 * createCache being the canonical case, where asserting the 500 would
 * institutionalise a server error as "correct" and asserting [200, 409] would
 * be permanently red.
 *
 * @returns {boolean} true if a 5xx was seen and recorded.
 */
function warnOnServerError(response, label, { reason = null, context = null } = {}) {
  if (!isServerError(response)) return false;
  recordServerError({ status: response.status, label, body: response.body, tolerated: true, reason, context });
  return true;
}

/**
 * Records a 5xx and then throws. The migration target for the ad-hoc
 * `assert(res.status < 500, "... - a server error")` guards scattered through
 * tests/races/ - `message` carries each site's original wording verbatim, so
 * migrating one changes what is RECORDED without changing what is REPORTED.
 */
function assertNoServerError(response, label, { message = null } = {}) {
  if (!isServerError(response)) return;
  recordServerError({ status: response.status, label, body: response.body, tolerated: false });
  const err = new Error(
    message || `${label || "request"} returned ${response.status} - a server error. Body: ${truncate(response.body)}`
  );
  err.serverError = { status: response.status, label, body: truncate(response.body) };
  throw err;
}

module.exports = {
  recordServerError,
  warnOnServerError,
  assertNoServerError,
  isServerError,
  truncate,
  SIDECAR_DIR,
};
