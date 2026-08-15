/**
 * CSV import writes every row exactly as given
 * ---------------------------------------------
 * The first scenario for the "peaka-tables" connector folder, and this
 * suite's first real write path into a Peaka Table - see
 * tests/peaka-tables/csv-import-happy-path.js.
 *
 * Same shape as jest/postgres/*.test.js: buildFreshCtx("peaka-tables") is
 * the only thing that differs from a Stripe test file.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtImport } = require("../../tests/peaka-tables/csv-import-happy-path");

let ctx = null;

test(
  "CSV import writes every row exactly as given",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("CSV import writes every row exactly as given", () => runPtImport(ctx));
  },
  120000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // The scenario deletes its own table as its last step, so this is normally
  // a no-op - it only does real work if the scenario failed before reaching
  // that step, leaving the table behind.
  const hasResources = ctx.createdInternalTableNames.length > 0 || ctx.createdBiTableNames.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
