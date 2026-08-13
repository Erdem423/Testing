/**
 * Repeated import
 * ----------------
 * See tests/peaka-tables/csv-import-repeats-append.js for what this asserts -
 * import appends unconditionally, with no replace mode and no deduplication,
 * which combined with FINDINGS 9/11 means a Peaka Table can only ever grow.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtRepeatImport } = require("../../tests/peaka-tables/csv-import-repeats-append");

let ctx = null;

test(
  "Repeated import appends instead of replacing",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("Repeated import appends instead of replacing", () => runPtRepeatImport(ctx));
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
