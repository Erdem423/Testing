/**
 * Delete purges data and schema
 * ------------------------------
 * See tests/peaka-tables/table-delete-purge.js. Pins a guarantee the whole
 * folder depends on: every scenario's "clean up any leftover table" step
 * assumes delete really destroys what the table held.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtDeletePurge } = require("../../tests/peaka-tables/table-delete-purge");

let ctx = null;

test(
  "Deleting a table purges its data and its schema",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("Deleting a table purges its data and its schema", () => runPtDeletePurge(ctx));
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
