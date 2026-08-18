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

  // Notes are per-step and reset here, unlike warnings, which accumulate for
  // the whole scenario and are therefore read as a delta.
  if (store) store.stepNotes = [];
  const notes = () => (store && store.stepNotes ? store.stepNotes.slice() : []);

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
      notes: notes(),
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
    notes: notes(),
  });
  if (store) store.stepName = null;
}

/**
 * Records something a reader needs to know about a step that still PASSED -
 * overwhelmingly, "this half of the step could not be attempted".
 *
 * WHY NOT console.log, WHICH IS WHAT THESE ALL USED TO BE: the dashboard's
 * event stream carries step-start/step-pass/step-fail and nothing else, so a
 * step that skipped its most interesting assertion rendered as an ordinary
 * green tick. Under `npm test` the console output was the whole story; from
 * the browser it was invisible. This keeps the console line AND puts the same
 * text on the step-pass event.
 *
 * NOT a warning: `warnings` means "passed while the server 5xx'd" and colours
 * the whole scenario. A note changes no status - it is shown, not scored.
 */
function note(message) {
  const store = currentStore();
  if (store) {
    if (!Array.isArray(store.stepNotes)) store.stepNotes = [];
    store.stepNotes.push(String(message));
  }
  console.log(message);
}

module.exports = { step, note };
