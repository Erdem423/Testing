/**
 * PT-12: CSV import - mapping errors
 * ------------------------------------
 * See tests/peaka-tables/pt-12-import-errors.js for what this actually
 * asserts - it diverges from the doc's literal expectations for one of the
 * four cases (a live-verified silent-success gap, not a doc typo).
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtImportErrors } = require("../../tests/peaka-tables/pt-12-import-errors");

let ctx = null;

test(
  "PT-12: CSV import — mapping errors",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("PT-12: CSV import — mapping errors", () => runPtImportErrors(ctx));
  },
  120000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  const hasResources = ctx.createdInternalTableNames.length > 0 || ctx.createdBiTableNames.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
