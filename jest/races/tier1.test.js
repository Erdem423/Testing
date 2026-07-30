/**
 * Tier 1 concurrency conflicts
 * ----------------------------
 * DELIBERATELY races cache operations against each other. See
 * CONCURRENCY-SPEC.md for the full conflict matrix and reasoning.
 *
 * ISOLATED ON PURPOSE. This lives in jest/races/, which jest.config.js
 * excludes, and runs only under `npm run test:races`. Two reasons:
 *
 *   1. It manufactures races. Running it beside the main suite would create
 *      UNINTENDED ones and produce failures that look like code regressions -
 *      not hypothetical: a stray dashboard server running a second suite
 *      against the same project once caused a 3x slowdown and four spurious
 *      failures during development.
 *   2. It caches `customers`, which C also caches. Overlapping those two is
 *      exactly the interference that forced the C/D merge.
 *
 * Also runs SEQUENTIALLY (one test, plain `test()`), because every step here
 * competes for the same table.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runTier1Races } = require("../../tests/stripe/races-tier1");

let ctx = null;

test(
  "RACE-T1: Cache operation conflicts",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("RACE-T1: Cache operation conflicts", () => runTier1Races(ctx));
  },
  // Generous: each step creates a fresh cache on a ~37s-syncing table and
  // waits for it to settle afterwards.
  600000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // Teardown matters more here than anywhere else - the point of these tests
  // is to leave resources in strange states, and a mid-sync resource may
  // refuse deletion on the first attempt. cleanup() is already per-item
  // best-effort; anything it cannot remove gets reported loudly below rather
  // than swallowed, because an orphan needs manual attention.
  const outcomes = await cleanup(ctx, (line) => console.log(line));
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) {
    console.log(
      `\n⚠ ${failed.length} resource(s) could not be deleted and need MANUAL cleanup:\n` +
        failed.map((f) => `   ${f.type} ${f.id} (status ${f.status || "threw"})`).join("\n")
    );
  }
}, 180000);
