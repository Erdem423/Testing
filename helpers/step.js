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
 */
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    err.message = `[${name}] ${err.message}`;
    throw err;
  }
}

module.exports = { step };
