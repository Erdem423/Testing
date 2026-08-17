/**
 * MO-A: Catalog & Schema Discovery
 * --------------------------------
 * The first scenario for the third connector. Same shape as
 * jest/postgres/pg-a-discovery.test.js - the only difference is
 * buildFreshCtx("mongodb"), which is the point.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gatedTest } = require("../../helpers/preflight");
const { runMoDiscovery } = require("../../tests/mongodb/mo-a-discovery");

let ctx = null;

// GATED on the connector being configured and its schema having a table over
// 100 rows - the cap-confirmation step needs one to distinguish "uncapped"
// from "capped at 100".
gatedTest(
  "MO-A: Catalog & Schema Discovery",
  "mongodb.anyTable",
  async () => {
    requireCredentials("mongodb");
    ctx = buildFreshCtx("mongodb");
    ctx.runTag = runTag();
    await withScenario("MO-A: Catalog & Schema Discovery", () => runMoDiscovery(ctx));
  },
  120000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  // This scenario creates nothing, so cleanup normally has nothing to do. It
  // runs anyway because one step DELIBERATELY attempts a createCache to prove
  // the rejection is enforced - if Peaka ever starts allowing it, that cache
  // is real and needs removing.
  if (ctx.createdCacheIds.length === 0) return;
  await cleanup(ctx, (line) => console.log(line));
}, 60000);
