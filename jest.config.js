/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/jest/**/*.test.js"],
  // jest/races/ and jest/hubspot-races/ are EXCLUDED from the default run on
  // purpose. Those tests deliberately manufacture concurrency conflicts and
  // cache tables that C also caches for each connector - running them
  // alongside the main suite would create unintended races and produce
  // failures that look like code regressions. They run under
  // `npm run test:races` via jest.races.config.js instead.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/jest/races/", "<rootDir>/jest/hubspot-races/"],
  testTimeout: 30000, // default per-test timeout; slow scenarios override it individually
  verbose: true,
  // Measures what data actually exists in the target environment ONCE, before
  // any test file loads, so data-dependent scenarios can gate themselves. Test
  // files read the result synchronously - see helpers/preflight.js for why that
  // forces the measurement up here rather than into a beforeAll.
  globalSetup: "<rootDir>/jest.globalSetup.js",
  // Always writes a JUnit XML report alongside the normal terminal output -
  // this is the kind of CI-ready output our custom runner doesn't produce
  // without hand-writing an XML serializer ourselves.
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "./test-results", outputName: "junit.xml" }],
    // Fails the run when scenarios were skipped for missing data, so a partial
    // run can never be mistaken for a full pass. ALLOW_INCOMPLETE=true opts out.
    "<rootDir>/jest/reporters/incompleteRun.js",
  ],
};
