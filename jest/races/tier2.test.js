/**
 * Tier 2 concurrency conflicts
 * ----------------------------
 * DELIBERATELY races cache operations against each other. See
 * CONCURRENCY-SPEC.md for the full conflict matrix and reasoning.
 *
 * ISOLATED ON PURPOSE, same as Tier 1: jest.config.js excludes jest/races/, and
 * these run only under `npm run test:races`.
 *
 * SAFETY: every step creates its OWN connection and catalog and deletes only
 * those. Several of them delete a catalog or connection outright, so operating
 * on PEAKA_CATALOG_ID would break every other test in the repo.
 *
 * One step (deleteCatalog mid-sync) is gated behind RUN_RISKY_RACES=true
 * because it can strand a cache that no endpoint enumerates.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runTier2Races } = require("../../tests/stripe/races-tier2");

let ctx = null;

test(
  "RACE-T2: Cross-resource conflicts",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("RACE-T2: Cross-resource conflicts", () => runTier2Races(ctx));
  },
  // Generous: each step provisions a throwaway connection + catalog (catalog
  // creation triggers metadata discovery), and the gated step also waits on a
  // ~37s cache sync.
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
