/**
 * Tier 3 concurrency conflicts
 * ----------------------------
 * DELIBERATELY races cache operations against each other. See
 * CONCURRENCY-SPEC.md for the full conflict matrix and reasoning.
 *
 * ISOLATED ON PURPOSE, same as Tier 1: jest.config.js excludes jest/races/, and
 * these run only under `npm run test:races`.
 *
 * NON-DESTRUCTIVE, unlike Tier 2: nothing here deletes a catalog or
 * connection. Metadata refreshes run against a throwaway catalog so they
 * cannot disturb B and C reading the shared one, and the parallel-query step
 * is read-only.
 *
 * The 20-parallel-query step also covers the instructor's scenario 19.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { assertSafeToRaceOrThrow } = require("../../helpers/racePreflight");
const { runTier3Races } = require("../../tests/races/tier3");

let ctx = null;

// Fail fast if another run looks active - see helpers/racePreflight.js. These
// tests manufacture races, so overlapping them with anything else produces
// failures that look like regressions but are not. That has happened twice.
beforeAll(async () => {
  requireCredentials();
  await assertSafeToRaceOrThrow(buildFreshCtx().client, (line) => console.log(line));
}, 30000);

test(
  "RACE-T3: Metadata races and parallel load",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("RACE-T3: Metadata races and parallel load", () => runTier3Races(ctx));
  },
  // Generous: provisions throwaway catalogs, polls metadata refreshes to
  // completion, and waits on a ~37s cache sync in the listTables step.
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
