const { assertStatus, assert, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~120s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeStatus(raw) {
  return String(raw || "").toUpperCase().replace(/-/g, "_");
}

const KNOWN_STATUSES = ["NOT_ACTIVE", "COMPLETED", "WAITING", "ACTIVE", "DELAYED", "FAILED", "PAUSED", "STUCK"];
const TERMINAL_STATUSES = ["NOT_ACTIVE", "COMPLETED", "FAILED", "STUCK"];

/**
 * Metadata-refresh endpoints, HubSpot version of tests/stripe/l-metadata.js.
 * This endpoint group is generic Peaka behavior, not connector-specific -
 * content mirrors the Stripe version except for `type: "hubspot"`.
 *
 * IMPORTANT: this runs against a catalog it creates ITSELF, not the shared
 * PEAKA_HUBSPOT_CATALOG_ID - refreshing metadata on the shared catalog while
 * B is listing tables/columns and C is querying it would be a genuine
 * interference risk, the same class of problem that forced Stripe's C/D
 * merge.
 *
 * BLOCKED ON A REAL HUBSPOT CREDENTIAL - see tests/hubspot/h-catalogs.js's
 * header comment, including the note on why reusing the existing connection
 * (to avoid needing a token) was tried and rejected by Peaka with a 500.
 */
async function runMetadata(ctx) {
  const name = `e2e-auto-meta-${ctx.runTag}`;
  let connectionId = null;
  let catalogId = null;

  await step("create a connection and catalog to refresh", async () => {
    const connRes = await ctx.client.createConnection({
      name,
      type: "hubspot",
      credential: { accessToken: ctx.token },
    });
    assertStatus(connRes, 200, "createConnection");
    connectionId = connRes.body.id;
    ctx.createdConnectionIds.push(connectionId);

    const catRes = await ctx.client.createCatalog({ name, connectionId });
    assertStatus(catRes, 200, "createCatalog");
    catalogId = catRes.body.id;
    ctx.createdCatalogIds.push(catalogId);
  });

  await step("read the refresh status before triggering anything", async () => {
    const res = await ctx.client.getMetadataRefreshStatus(catalogId);
    assertStatus(res, 200, "getMetadataRefreshStatus (before)");
    assert(res.body && res.body.status !== undefined, `Expected a status field, got: ${JSON.stringify(res.body)}`);
    assertIncludes(KNOWN_STATUSES, normalizeStatus(res.body.status), "metadata refresh status");
  });

  await step("trigger a metadata refresh", async () => {
    const res = await ctx.client.refreshMetadata({ catalogId });
    assertStatus(res, 200, "refreshMetadata");
  });

  await step("refresh status reaches a terminal state", async () => {
    let last = null;
    let terminal = false;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const res = await ctx.client.getMetadataRefreshStatus(catalogId);
      assertStatus(res, 200, "getMetadataRefreshStatus (polling)");
      last = res.body;
      const status = normalizeStatus(res.body.status);
      assertIncludes(KNOWN_STATUSES, status, "metadata refresh status");
      if (TERMINAL_STATUSES.includes(status)) {
        terminal = true;
        console.log(`metadata refresh settled at '${res.body.status}' after ~${attempt * (POLL_INTERVAL_MS / 1000)}s`);
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    assert(
      terminal,
      `Metadata refresh did not settle after ${MAX_POLL_ATTEMPTS} attempts ` +
        `(~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s). Last response: ${JSON.stringify(last)}`
    );
    assert(
      normalizeStatus(last.status) !== "FAILED" && normalizeStatus(last.status) !== "STUCK",
      `Metadata refresh ended in a bad state: ${JSON.stringify(last)}`
    );
  });

  await step("the catalog is still discoverable after refreshing", async () => {
    const res = await ctx.client.listSchemas(catalogId);
    assertStatus(res, 200, "listSchemas after refresh");
    assert(Array.isArray(res.body) && res.body.length > 0, "Expected at least one schema after a metadata refresh");
  });
}

module.exports = { runMetadata };
