/**
 * Tiny assertion helper. Throws on failure with a readable message.
 * Kept dependency-free on purpose so the whole suite runs with just `node`.
 */
const { recordServerError, isServerError, truncate } = require("./serverError");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEqual(actual, expected, label = "value") {
  assert(actual === expected, `Expected ${label} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertApprox(actual, expected, tolerancePct, label = "value") {
  const lower = expected * (1 - tolerancePct);
  const upper = expected * (1 + tolerancePct);
  assert(
    actual >= lower && actual <= upper,
    `Expected ${label} to be within ${tolerancePct * 100}% of ${expected} (${lower.toFixed(1)}-${upper.toFixed(
      1
    )}), got ${actual}`
  );
}

function assertIncludes(array, value, label = "array") {
  assert(array.includes(value), `Expected ${label} to include ${JSON.stringify(value)}. Got: ${JSON.stringify(array)}`);
}

/**
 * 5xx AWARENESS lives here rather than in each scenario, because this is the
 * choke point every status check already funnels through - which makes
 * server-error detection a property of the response instead of a discipline
 * every test author has to remember. See helpers/serverError.js for why it
 * matters and doc2.txt rule 6 for the rule it enforces.
 *
 * The thrown MESSAGES below are deliberately byte-identical to what they were
 * before 5xx handling existed. A 500 changes what gets RECORDED, never what
 * gets REPORTED - so no existing failure output shifts.
 */
function assertStatus(response, expectedStatus, label = "request") {
  const ok = response.status === expectedStatus;
  if (isServerError(response)) {
    // A 5xx that IS the expected status is tolerated (nothing in the suite
    // does this today, but assertStatusIn's sibling case does).
    recordServerError({
      status: response.status,
      label,
      body: response.body,
      tolerated: ok,
      reason: ok ? "(no rationale recorded)" : null,
    });
  }
  if (ok) return;

  const message = `Expected ${label} to return status ${expectedStatus}, got ${response.status}. Body: ${JSON.stringify(
    response.body
  )}`;
  const err = new Error(message);
  // Lets the reporter tell "this failed AND hit a server error" apart from an
  // ordinary expectation mismatch.
  if (isServerError(response)) {
    err.serverError = { status: response.status, label, body: truncate(response.body) };
  }
  throw err;
}

/**
 * `tolerate5xx` is a RATIONALE STRING, not a boolean - passing one says "this
 * 5xx is known, here is why we accept it". A 5xx accepted without one still
 * passes (introducing a new throw path would be a behaviour change), but is
 * recorded as "(no rationale recorded)" so the run banner nags about it.
 */
function assertStatusIn(response, expectedStatuses, label = "request", { tolerate5xx = null } = {}) {
  const ok = expectedStatuses.includes(response.status);
  if (isServerError(response)) {
    recordServerError({
      status: response.status,
      label,
      body: response.body,
      tolerated: ok,
      reason: ok ? tolerate5xx || "(no rationale recorded)" : null,
    });
  }
  if (ok) return;

  const message = `Expected ${label} to return one of [${expectedStatuses.join(", ")}], got ${
    response.status
  }. Body: ${JSON.stringify(response.body)}`;
  const err = new Error(message);
  if (isServerError(response)) {
    err.serverError = { status: response.status, label, body: truncate(response.body) };
  }
  throw err;
}

module.exports = { assert, assertEqual, assertApprox, assertIncludes, assertStatus, assertStatusIn };
