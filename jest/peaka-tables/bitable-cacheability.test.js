/**
 * Cache creation on a BI Table fails before it can be refused
 * -----------------------------------------------------------
 * UNGATED - cacheability does not depend on rows, so this creates its own
 * throwaway BI Table and runs in any project, unlike the other BI scenarios.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runBiTableCacheability } = require("../../tests/peaka-tables/bitable-cacheability");

let ctx = null;

test(
  "Cache creation on a BI Table fails before it can be refused",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("Cache creation on a BI Table fails before it can be refused", () => runBiTableCacheability(ctx));
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
