/**
 * Entry point for running Jest in its OWN OS process, forked from server.js
 * (see /api/run-stream) instead of calling runCLI() in-process like before.
 *
 * WHY: runCLI() has no cancellation API - once started, there is no way to
 * stop it short of killing the process it's running in. Running it in-process
 * (the original design) meant a "Stop" button had nothing to kill without
 * taking server.js itself down. Forking this file gives the dashboard a real
 * OS process handle - server.js can child.kill() it and execution genuinely
 * stops immediately, mid-test.
 *
 * Reads its run config from JEST_RUN_CONFIG (JSON: { config, testNamePattern }),
 * set as an env var by the parent when forking (see server.js). Live events
 * (steps, results) reach the parent over plain HTTP (PEAKA_STEP_REPORT_URL,
 * also inherited via env) - see helpers/stepReporter.js and jest/
 * browserReporter.js - NOT over the fork's IPC channel, so this file stays a
 * thin, dumb runner with no message-passing logic of its own.
 *
 * Killing this process mid-run means Jest's afterAll() cleanup hooks never
 * execute - any real Peaka resources (connections/catalogs/caches) the
 * killed run had already created are NOT deleted. server.js's cancel
 * endpoint's response says so; worth knowing if you build on this.
 */
const { runCLI } = require("jest");
const { measure } = require("../helpers/preflight");

async function main() {
  const { config, testNamePattern } = JSON.parse(process.env.JEST_RUN_CONFIG);
  const argv = { config, runInBand: true, ...(testNamePattern ? { testNamePattern } : {}) };
  try {
    // Measure the environment before Jest collects anything. The config above
    // deliberately omits globalSetup (it's a purpose-built dashboard config,
    // not jest.config.js), which meant NOTHING in the dashboard path ever
    // called measure() - so helpers/preflight.js's gate() fell back to
    // whatever test-results/preflight.json happened to be left on disk by the
    // last `npm test`, or to nothing at all. gate() deliberately defaults to
    // OPEN when it has no measurement (see its comment: skipping should only
    // ever follow a real measurement), so the failure mode was not "skips
    // everything" - it was the opposite: gated scenarios silently RAN FOR
    // REAL against data that was never there, and the slow ones then hung for
    // their full multi-minute timeout instead of skipping in milliseconds.
    //
    // Deliberately not caught separately - same reasoning as
    // jest.globalSetup.js: an environment that cannot be measured should fail
    // the run loudly rather than continue with every gate guessing.
    await measure();
    const { results } = await runCLI(argv, [process.cwd()]);
    process.exit(results.success ? 0 : 1);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
