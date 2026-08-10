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

  // So helpers/serverError.js can attribute a 5xx to the exact step that saw
  // it, rather than only to the scenario.
  if (store) store.stepName = name;

  // Warnings are read as a DELTA off the shared store rather than from fn()'s
  // return value, which stays discarded - scenarios return nothing today and
  // making them return something would be a much larger change for no gain.
  const warningsBefore = store && store.serverErrors ? store.serverErrors.length : 0;
  const newWarnings = () => (store && store.serverErrors ? store.serverErrors.slice(warningsBefore) : []);

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
      // Distinguishes "this step failed" from "this step failed AND the server
      // errored", which are different problems with different owners.
      warnings: newWarnings(),
      serverError: !!(err && err.serverError),
    });
    if (store) store.stepName = null;
    err.message = `[${name}] ${err.message}`;
    throw err;
  }

  // Carried on step-pass rather than a separate step-warn event: public/app.js
  // overwrites state.steps[scenario][name] wholesale, so a step-warn followed
  // by a step-pass would erase itself. server.js forwards any event with a
  // string `type` untouched, so the extra field needs no server change.
  await emit({
    type: "step-pass",
    scenario,
    name,
    index,
    duration: Date.now() - startedAt,
    warnings: newWarnings(),
  });
  if (store) store.stepName = null;
}

module.exports = { step };
