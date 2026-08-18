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
 * 500 and a 400 produced byte-identical failure messages. The gap was a known
 * one - "no '5xx is always a failure' invariant, applied ad hoc rather than
 * globally" - which is what this module closes.
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

/**
 * Deletes only sidecar files whose pid is no longer a live process - never a
 * blind wipe of the whole directory.
 *
 * The dashboard can now run several connectors CONCURRENTLY, each in its own
 * forked child with its own pid file here. Clearing the whole directory when a
 * run starts - which is what server.js used to do - would delete the records a
 * sibling run had already written and was still writing to. A pid that is
 * still alive belongs to an active dashboard run or an active `npm test`
 * worker, so it stays; anything whose process is gone is left over from a run
 * that already finished or crashed, and is safe to clear.
 */
function reapStaleServerErrorFiles() {
  let entries;
  try {
    entries = fs.readdirSync(SIDECAR_DIR);
  } catch (_) {
    return; // directory doesn't exist yet - nothing to reap
  }
  for (const name of entries) {
    const match = /^(\d+)\.jsonl$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    let alive = true;
    try {
      process.kill(pid, 0); // signal 0 tests for existence without actually signalling
    } catch (err) {
      alive = err.code === "EPERM"; // exists but owned by another user - leave it alone
    }
    if (!alive) {
      try {
        fs.unlinkSync(path.join(SIDECAR_DIR, name));
      } catch (_) {
        // Best-effort - a stale file left behind is a reporting nuisance, not a failure.
      }
    }
  }
}

module.exports = {
  recordServerError,
  warnOnServerError,
  assertNoServerError,
  isServerError,
  truncate,
  SIDECAR_DIR,
  reapStaleServerErrorFiles,
};
