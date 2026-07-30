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
  testTimeout: 600000,
  maxWorkers: 1,
  verbose: true,
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "./test-results", outputName: "junit-races.xml" }],
  ],
};
