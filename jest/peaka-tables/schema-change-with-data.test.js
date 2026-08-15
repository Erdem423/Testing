/**
 * Schema changes apply cleanly to a table that already holds data
 * ----------------------------------------------------------------
 * See tests/peaka-tables/schema-change-with-data.js. The most customer-shaped
 * scenario in the folder: adding a column to a populated table, dropping one
 * that holds data, and relabelling one - all working, all pinned.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtSchemaChange } = require("../../tests/peaka-tables/schema-change-with-data");

let ctx = null;

test(
  "Schema changes apply cleanly to a table that already holds data",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("Schema changes apply cleanly to a table that already holds data", () => runPtSchemaChange(ctx));
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
