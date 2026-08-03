/**
 * O: Data Freshness
 * ------------------------
 * Does a cache refresh pick up a row added at the SOURCE? Creates a real Stripe
 * customer, refreshes, and asserts it becomes visible - then deletes it again.
 *
 * THE ONLY SCENARIO THAT WRITES TO STRIPE. The customer id is tracked on
 * ctx.createdStripeCustomerIds as soon as it exists, and helpers/cleanup.js
 * deletes Stripe customers FIRST, before any Peaka resource: a leftover customer
 * permanently shifts the row counts scenario C asserts against, whereas a
 * leftover cache is only debris.
 *
 * Timeout is generous - `customers` syncs in ~37s and this scenario may refresh
 * it up to three times (incremental, full refresh, then again after the
 * upstream delete).
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { withScenario } = require("../../helpers/stepReporter");
const { cleanup } = require("../../helpers/cleanup");
const { runDataFreshness } = require("../../tests/stripe/o-data-freshness");

let ctx = null;

test(
  "O: Data Freshness",
  async () => {
    requireCredentials();
    ctx = buildFreshCtx();
    ctx.runTag = runTag();
    await withScenario("O: Data Freshness", () => runDataFreshness(ctx));
  },
  420000
);

afterAll(async () => {
  if (!ctx) return;
  if (process.env.SKIP_CLEANUP === "true") {
    // Deliberately still warns: a skipped cleanup here leaves an UPSTREAM
    // customer behind, which is more consequential than leftover Peaka state.
    if (ctx.createdStripeCustomerIds && ctx.createdStripeCustomerIds.length > 0) {
      console.log(
        `⚠ SKIP_CLEANUP left ${ctx.createdStripeCustomerIds.length} Stripe customer(s) in the account: ` +
          `${ctx.createdStripeCustomerIds.join(", ")}. Delete them, or the counts C asserts against shift.`
      );
    }
    console.log("Cleanup skipped (SKIP_CLEANUP=true).");
    return;
  }
  const hasResources =
    ctx.createdStripeCustomerIds.length > 0 ||
    ctx.createdCacheIds.length > 0 ||
    ctx.createdQueryIds.length > 0 ||
    ctx.createdInternalTableNames.length > 0 ||
    ctx.createdCatalogIds.length > 0 ||
    ctx.createdConnectionIds.length > 0;
  if (!hasResources) return;
  await cleanup(ctx, (line) => console.log(line));
}, 120000);
