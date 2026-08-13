/**
 * Unique and not-null flags are silently discarded at column creation
 * --------------------------------------------------------------------
 * See tests/peaka-tables/column-constraints.js. Not an enforcement question:
 * the two flags never round-trip at all, while defaultValue works end to end.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtConstraints } = require("../../tests/peaka-tables/column-constraints");

let ctx = null;

test(
  "Unique and not-null flags are silently discarded at column creation",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("Unique and not-null flags are silently discarded at column creation", () =>
      runPtConstraints(ctx)
    );
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
