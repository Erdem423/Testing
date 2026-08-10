/** @type {import('jest').Config} */
/**
 * Config for the deliberate-concurrency suite (`npm run test:races`).
 *
 * Separate from jest.config.js so these can never be picked up by a plain
 * `npm test` - see the note there, and CONCURRENCY-SPEC.md for why isolation
 * is a correctness requirement rather than tidiness.
 *
 * maxWorkers is 1: every scenario here competes for the same slow-syncing
 * table, so running them in parallel would race the races.
 */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/jest/races/**/*.test.js"],
  // 1200s, not 600s. Tier 1 was measured at 407s under contention against the
  // old 600s ceiling - close enough that a slower day would report a TIMEOUT
  // rather than the real failure, which is exactly the misleading-failure mode
  // this project avoids elsewhere.
  testTimeout: 1200000,
  maxWorkers: 1,
  verbose: true,
  // Same preflight as the main config - the races cache `customers`, so they
  // need the same "is there actually data here" gate.
  globalSetup: "<rootDir>/jest.globalSetup.js",
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "./test-results", outputName: "junit-races.xml" }],
    "<rootDir>/jest/reporters/incompleteRun.js",
  ],
};
