/**
 * Invalid values are rejected strictly and atomically
 * ----------------------------------------
 * See tests/peaka-tables/csv-import-type-coercion.js - this one pins GOOD
 * behaviour (strict, atomic value validation) rather than a deviation, so a
 * future relaxation toward the lax mapping handling in FINDINGS #10 is caught.
 *
 * Plain `test`, not gatedTest, matching the rest of this folder: preflight has
 * no `peaka-tables` branch, and gate() returns OPEN for any unknown key - so a
 * gated call here would always run while merely LOOKING gated. This folder
 * needs nothing beyond PEAKA_API_KEY/PEAKA_PROJECT_ID anyway.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtTypeCoercion } = require("../../tests/peaka-tables/csv-import-type-coercion");

let ctx = null;

test(
  "Invalid values are rejected strictly and atomically",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("Invalid values are rejected strictly and atomically", () => runPtTypeCoercion(ctx));
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
