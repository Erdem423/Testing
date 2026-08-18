const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * Catalog endpoints, HubSpot version of tests/stripe/h-catalogs.js.
 *
 * Creates its OWN connection and catalog and deletes both. It must never
 * delete PEAKA_HUBSPOT_CATALOG_ID - that's the real, hand-provisioned catalog
 * every other HubSpot scenario depends on. Assertions that touch the shared
 * catalog are read-only.
 *
 * BLOCKED ON A REAL HUBSPOT CREDENTIAL. createConnection below needs
 * HUBSPOT_ACCESS_TOKEN - see tests/hubspot/g-connections.js's header comment
 * for the confirmed OAuth2 credential shape. If this starts failing at the
 * connection-creation step specifically, that's the first thing to check.
 *
 * ATTRIBUTION CORRECTED 2026-08-18 - see FINDINGS.md #38. The 500 below is
 * real and reproducible, but it is a property of the PROJECT, not of attaching
 * a second catalog to a connection: the same call returns 500 for every
 * connection in this project and 200 for every connection in another. The
 * Stripe scenarios now provision catalogs exactly this way
 * (helpers/provisionCatalog.js) and succeed. The original note follows,
 * because the observation itself was accurate.
 *
 * TRIED AND REJECTED BY PEAKA (2026-08-12): attaching this scenario's catalog
 * to the EXISTING connection behind PEAKA_HUBSPOT_CATALOG_ID instead of
 * creating a new one - would have avoided needing a token at all, since
 * createCatalog() accepts any connectionId in principle. Reproduced across
 * H/L/M/N: Peaka returns a real `500 Internal Server Error` on createCatalog
 * every time a second catalog is attached to a connection that already has
 * one. Whatever the exact constraint is (one catalog per connection? something
 * else?), Peaka does NOT support it - confirmed by trying it against the real
 * API, not assumed. So this genuinely needs its own connection, token and all.
 * (helpers/provisionCatalog.js, which implemented the rejected approach, was
 * removed rather than left as unused/misleading code.)
 */
async function runCatalogs(ctx) {
  const name = `e2e-auto-catalog-${ctx.runTag}`;
  let connectionId = null;
  let catalogId = null;

  await step("create a connection to hang the catalog off", async () => {
    const res = await ctx.client.createConnection({
      name,
      type: "hubspot",
      credential: { accessToken: ctx.token },
    });
    assertStatus(res, 200, "createConnection");
    connectionId = res.body.id;
    ctx.createdConnectionIds.push(connectionId);
  });

  await step("create a catalog", async () => {
    const res = await ctx.client.createCatalog({ name, connectionId });
    assertStatus(res, 200, "createCatalog");
    assert(res.body && res.body.id, "Expected a catalog id in the response");
    catalogId = res.body.id;
    ctx.createdCatalogIds.push(catalogId);
  });

  await step("list catalogs includes the new one and the configured one", async () => {
    const res = await ctx.client.listCatalogs();
    assertStatus(res, 200, "listCatalogs");
    assert(Array.isArray(res.body), "Expected an array of catalogs");
    assert(
      res.body.some((c) => c.id === catalogId),
      `Newly created catalog ${catalogId} not found in listCatalogs`
    );
    assert(
      res.body.some((c) => String(c.id) === String(ctx.catalogId)),
      `Configured PEAKA_HUBSPOT_CATALOG_ID (${ctx.catalogId}) not present in listCatalogs - check .env`
    );
  });

  await step("search finds a known HubSpot table", async () => {
    const res = await ctx.client.search({ query: "contacts", limit: 10 });
    assertStatus(res, 200, "search");
    const tables = res.body.matchedTables || [];
    assert(
      tables.some((t) => t.table === "contacts"),
      `Expected search('contacts') to match a 'contacts' table. Got: ${JSON.stringify(res.body).slice(0, 300)}`
    );
  });

  // UNLIKE the Stripe version, this does NOT assume table statistics are
  // unsupported for hubspot catalogs - that's a Stripe-specific confirmed
  // limitation (400 "Catalog type: stripe is not being supported yet"), and
  // there's no reason to assume HubSpot hits the same gap. This just asserts
  // the endpoint responds cleanly either way (real stats, or an explained
  // 4xx) and logs which branch was hit so this can be tightened into a real
  // assertion once observed.
  await step("table statistics: log whether hubspot catalogs are supported", async () => {
    const res = await ctx.client.getTableStatistics(ctx.catalogId, ctx.schemaName, "contacts");
    if (res.status === 200) {
      console.log(`note: getTableStatistics returned 200 for a hubspot catalog: ${JSON.stringify(res.body).slice(0, 200)}`);
    } else {
      console.log(`note: getTableStatistics returned ${res.status} for a hubspot catalog: ${JSON.stringify(res.body).slice(0, 200)}`);
    }
    assertStatusIn(res, [200, 400], "getTableStatistics on a hubspot catalog");
  });

  await step("delete the catalog and confirm it is gone", async () => {
    const res = await ctx.client.deleteCatalog(catalogId);
    assertStatus(res, 200, "deleteCatalog");
    ctx.createdCatalogIds = ctx.createdCatalogIds.filter((id) => id !== catalogId);

    const list = await ctx.client.listCatalogs();
    assertStatus(list, 200, "listCatalogs after delete");
    assert(!list.body.some((c) => c.id === catalogId), "Deleted catalog still appears in listCatalogs");
    assert(
      list.body.some((c) => String(c.id) === String(ctx.catalogId)),
      "The configured PEAKA_HUBSPOT_CATALOG_ID disappeared - this scenario must only ever delete its own catalog"
    );
  });
}

module.exports = { runCatalogs };
