/**
 * A materialized query over an internal table never goes stale
 * --------------------------------------------------------------
 * See tests/peaka-tables/materialized-never-stale.js. Peaka's docs promise a
 * snapshot that "can be slightly stale between refreshes"; over an internal
 * table there is no snapshot at all - appended rows appear immediately. The
 * exact inverse of FINDINGS 2, where a Stripe materialization freezes at 100
 * rows permanently.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtMaterialized } = require("../../tests/peaka-tables/materialized-never-stale");

let ctx = null;

test(
  "A materialized query over an internal table never goes stale",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("A materialized query over an internal table never goes stale", () => runPtMaterialized(ctx));
  },
  180000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  const hasResources =
    ctx.createdInternalTableNames.length > 0 || ctx.createdBiTableNames.length > 0 || ctx.createdQueryIds.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
