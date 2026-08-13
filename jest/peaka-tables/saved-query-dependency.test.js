/**
 * A saved query tracks changes to the table beneath it
 * ------------------------------------------------------
 * See tests/peaka-tables/saved-query-dependency.js. The deepest chain in the
 * folder: the final question - does an orphaned query re-bind to a recreated
 * table? - is unreachable except after five prior steps. It does.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtSavedQuery } = require("../../tests/peaka-tables/saved-query-dependency");

let ctx = null;

test(
  "A saved query tracks changes to the table beneath it",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("A saved query tracks changes to the table beneath it", () => runPtSavedQuery(ctx));
  },
  120000
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
