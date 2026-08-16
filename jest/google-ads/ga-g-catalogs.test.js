/**
 * GA-G: Catalog Endpoints
 * -----------------------
 * See tests/google-ads/ga-g-catalogs.js for what this asserts, and why it's
 * scoped down from the Postgres/MongoDB equivalent (no catalog create/delete
 * - Google Ads needs real OAuth credentials for that, which this suite
 * doesn't have).
 */
const { buildFreshCtx, requireCredentials, runTag } = require("../../helpers/buildCtx");
const { gatedTest } = require("../../helpers/preflight");
const { withScenario } = require("../../helpers/stepReporter");
const { runGaCatalogs } = require("../../tests/google-ads/ga-g-catalogs");

gatedTest(
  "GA-G: Catalog Endpoints",
  "googleAds.anyTable",
  async () => {
    requireCredentials("google-ads");
    const ctx = buildFreshCtx("google-ads");
    ctx.runTag = runTag();
    await withScenario("GA-G: Catalog Endpoints", () => runGaCatalogs(ctx));
  },
  // Was 60000 - timed out once under full-suite load (all connectors' Jest
  // workers hitting Peaka concurrently), on a connector already measured to
  // be intermittently slow/flaky (finding 35). Matches the other GA-*
  // timeouts rather than assuming this lighter scenario needs less room.
  120000
);
