/**
 * CMP: join across two Peaka Tables - adapted from the doc's CMP-02.
 * See tests/peaka-tables/cmp-internal-join.js for why.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runCmpInternalJoin } = require("../../tests/peaka-tables/cmp-internal-join");

let ctx = null;

test(
  "CMP: join across two Peaka Tables",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("CMP: join across two Peaka Tables", () => runCmpInternalJoin(ctx));
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
