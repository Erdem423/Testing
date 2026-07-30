const { currentStore, emit } = require("./stepReporter");

/**
 * Runs a named sub-step inside a consolidated category test. If `fn` throws,
 * the error message is prefixed with the step name so a failure in a
 * multi-step test (e.g. "B: Catalog & Schema Discovery") still tells you
 * exactly which internal check failed - without needing that check to be a
 * separately-runnable test of its own.
 *
 * Steps run strictly in the order you call them (plain sequential await) -
 * if one throws, later steps in the same category simply don't run, the
 * same as any normal function that throws partway through.
 *
 * Also emits live start/pass/fail events for the web dashboard when the run
 * was launched from it (see helpers/stepReporter.js). Under a plain
 * `npm test` those emits are no-ops, and the error-prefixing behaviour is
 * unchanged either way - reporting is strictly additive here.
 */
async function step(name, fn) {
  const store = currentStore();
  const scenario = store ? store.scenario : null;
  const index = store ? store.index++ : 0;
  const startedAt = Date.now();

  await emit({ type: "step-start", scenario, name, index });

  try {
    await fn();
  } catch (err) {
    await emit({
      type: "step-fail",
      scenario,
      name,
      index,
      duration: Date.now() - startedAt,
      message: String(err && err.message ? err.message : err),
    });
    err.message = `[${name}] ${err.message}`;
    throw err;
  }

  await emit({ type: "step-pass", scenario, name, index, duration: Date.now() - startedAt });
}

module.exports = { step };
