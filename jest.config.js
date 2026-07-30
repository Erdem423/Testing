/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/jest/**/*.test.js"],
  // jest/races/ is EXCLUDED from the default run on purpose. Those tests
  // deliberately manufacture concurrency conflicts and cache `customers`,
  // which C also caches - running them alongside the main suite would create
  // unintended races and produce failures that look like code regressions.
  // They run under `npm run test:races` via jest.races.config.js instead.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/jest/races/"],
  testTimeout: 30000, // default per-test timeout; slow scenarios override it individually
  verbose: true,
  // Always writes a JUnit XML report alongside the normal terminal output -
  // this is the kind of CI-ready output our custom runner doesn't produce
  // without hand-writing an XML serializer ourselves.
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "./test-results", outputName: "junit.xml" }],
  ],
};
