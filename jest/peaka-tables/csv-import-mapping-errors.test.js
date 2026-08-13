/**
 * A bad mapping silently writes NULL instead of failing
 * ------------------------------------------------------
 * See tests/peaka-tables/csv-import-mapping-errors.js for what this actually
 * asserts - it diverges from the doc's literal expectations for one of the
 * four cases (a live-verified silent-success gap, not a doc typo).
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtImportErrors } = require("../../tests/peaka-tables/csv-import-mapping-errors");

let ctx = null;

test(
  "A bad mapping silently writes NULL instead of failing",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("A bad mapping silently writes NULL instead of failing", () => runPtImportErrors(ctx));
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
