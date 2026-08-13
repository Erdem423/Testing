/**
 * A populated BI Table refuses every documented write
 * -----------------------------------------------------
 * See tests/peaka-tables/bitable-write-refusal.js. Peaka's docs describe
 * row-by-row updates, deletions, insertions and bulk insertion as BI Table
 * capabilities; the Partner API offers none of them. With real rows present
 * the scenario can finally prove the data is untouched afterwards, which an
 * empty table could never demonstrate.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gatedTest } = require("../../helpers/preflight");
const { runBiTableWriteRefusal } = require("../../tests/peaka-tables/bitable-write-refusal");

let ctx = null;

gatedTest(
  "A populated BI Table refuses every documented write",
  "peakaTables.biTableWithData",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("A populated BI Table refuses every documented write", () => runBiTableWriteRefusal(ctx));
  },
  120000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // This scenario creates nothing - it only attempts writes that all fail -
  // but the guard stays for symmetry with the rest of the folder.
  const hasResources = ctx.createdInternalTableNames.length > 0 || ctx.createdBiTableNames.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
