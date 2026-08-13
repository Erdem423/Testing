/**
 * The sample endpoint returns a type-aware template with example rows
 * --------------------------------------------------------------------
 * See tests/peaka-tables/sample-endpoint.js. The endpoint is a TEMPLATE
 * generator and it conforms to the spec, so this pins working behaviour; the
 * one deviation is an undeclared `text` column in the header. Also covers the
 * client-side JSON-parsing bug fixed to measure it at all (see peakaClient.js).
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runPtSample } = require("../../tests/peaka-tables/sample-endpoint");

let ctx = null;

test(
  "The sample endpoint returns a type-aware template with example rows",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("The sample endpoint returns a type-aware template with example rows", () => runPtSample(ctx));
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
