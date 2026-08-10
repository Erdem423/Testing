/**
 * PT-08: point-edit UPDATE/DELETE - capability-gap pin, not the doc's
 * scenario as written. See tests/peaka-tables/pt-08-no-row-edit.js.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtNoRowEdit } = require("../../tests/peaka-tables/pt-08-no-row-edit");

let ctx = null;

test(
  "PT-08: point-edit UPDATE/DELETE (capability gap)",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("PT-08: point-edit UPDATE/DELETE (capability gap)", () => runPtNoRowEdit(ctx));
  },
  60000
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
