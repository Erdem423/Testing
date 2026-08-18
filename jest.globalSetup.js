const fs = require("fs");
const { measure } = require("./helpers/preflight");
const { autoConfigureConnectors } = require("./helpers/autoConfigure");
const { SIDECAR_DIR } = require("./helpers/serverError");

/**
 * Measures the target environment ONCE, before any test file is loaded.
 *
 * Scenarios that need seeded data read the result synchronously (Jest decides
 * which tests exist at module-load time, so they cannot await anything) and
 * skip themselves if the data is absent - see helpers/preflight.js.
 *
 * Deliberately NOT wrapped in a try/catch. If the environment cannot be
 * measured, that is an API or config failure and the whole run must stop here
 * rather than continue with every gate reporting "no data" - a silent
 * skip-everything run is exactly the outcome this design exists to prevent.
 */
module.exports = async () => {
  // Server-error records are per-run. Left behind, they would be reported as
  // phantom warnings by the NEXT run - and because server.js's inline runCLI
  // config omits this globalSetup entirely, a dashboard run can leave records
  // that no reporter ever consumes. server.js clears the same directory for
  // that reason; both sites are needed.
  try {
    fs.rmSync(SIDECAR_DIR, { recursive: true, force: true });
  } catch (_) {
    // Never fatal - a stale record is a reporting nuisance, not a test failure.
  }

  // BEFORE measuring: fill in whatever the user did not set, by looking at the
  // project. The preflight reads these env vars, so this has to run first.
  // Set by server.js for a dashboard run, unset for `npm test`.
  const only = process.env.PEAKA_MEASURE_ONLY || null;

  await autoConfigureConnectors({ only, log: (msg) => console.log(`
${msg}
`) });

  const report = await measure({ only });

  const lines = [];
  for (const [connector, result] of Object.entries(report)) {
    if (!result || typeof result !== "object" || !result.gates) continue;
    const closed = Object.entries(result.gates).filter(([, g]) => !g.ok);
    if (closed.length === 0) continue;
    for (const [capability, g] of closed) {
      lines.push(`  ${connector}.${capability}: ${g.reason}`);
    }
  }

  if (lines.length > 0) {
    console.log("\nPreflight found missing data - some scenarios will be SKIPPED:");
    console.log(lines.join("\n"));
    console.log("");
  }
};
