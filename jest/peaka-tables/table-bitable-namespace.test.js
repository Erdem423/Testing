/**
 * A Peaka Table and BI Table sharing a name stay isolated
 * --------------------------------------------------------
 * See tests/peaka-tables/table-bitable-namespace.js. Covers the spec's CMP-01,
 * plus the collision the spec's own version never creates - underscore
 * stripping means "the same requested name" produces two different tables.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtBiNamespace } = require("../../tests/peaka-tables/table-bitable-namespace");

let ctx = null;

test(
  "A Peaka Table and BI Table sharing a name stay isolated",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("A Peaka Table and BI Table sharing a name stay isolated", () => runPtBiNamespace(ctx));
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
