/**
 * A federated join inherits the Stripe row cap
 * ----------------------------------------------
 * See tests/peaka-tables/federated-join-cap.js.
 *
 * GATED ON A COMPOSITE KEY, because this scenario needs TWO connectors: Stripe
 * for the capped side and Postgres for the control that proves the join itself
 * is not the limiter. It was originally gated on stripe.customers alone, which
 * left it hard-failing whenever Postgres was absent - the same "gated on less
 * than it needs" bug PG-G and PG-I had. peakaTables.federatedJoin is computed
 * in measure() from both connectors' gates.
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { gatedTest } = require("../../helpers/preflight");
const { runPtFederatedJoin } = require("../../tests/peaka-tables/federated-join-cap");

let ctx = null;

gatedTest(
  "A federated join inherits the Stripe row cap",
  "peakaTables.federatedJoin",
  async () => {
    requireCredentials("peaka-tables");
    ctx = buildFreshCtx("peaka-tables");
    ctx.runTag = runTag();
    await withScenario("A federated join inherits the Stripe row cap", () => runPtFederatedJoin(ctx));
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
