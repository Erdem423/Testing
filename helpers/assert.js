/**
 * Tiny assertion helper. Throws on failure with a readable message.
 * Kept dependency-free on purpose so the whole suite runs with just `node`.
 */

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

function assertStatus(response, expectedStatus, label = "request") {
  assert(
    response.status === expectedStatus,
    `Expected ${label} to return status ${expectedStatus}, got ${response.status}. Body: ${JSON.stringify(
      response.body
    )}`
  );
}

function assertStatusIn(response, expectedStatuses, label = "request") {
  assert(
    expectedStatuses.includes(response.status),
    `Expected ${label} to return one of [${expectedStatuses.join(", ")}], got ${response.status}. Body: ${JSON.stringify(
      response.body
    )}`
  );
}

module.exports = { assert, assertEqual, assertApprox, assertIncludes, assertStatus, assertStatusIn };
