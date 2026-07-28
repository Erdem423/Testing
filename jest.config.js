/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/jest/**/*.test.js"],
  testTimeout: 30000, // default per-test timeout; beforeAll has its own longer timeout (see jest/stripe/connector.test.js)
  verbose: true,
  // Always writes a JUnit XML report alongside the normal terminal output -
  // this is the kind of CI-ready output our custom runner doesn't produce
  // without hand-writing an XML serializer ourselves.
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "./test-results", outputName: "junit.xml" }],
  ],
};
