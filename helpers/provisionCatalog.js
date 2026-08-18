const { assertStatus, assert } = require("./assert");

/**
 * Creates a throwaway catalog on the connection the suite is ALREADY pointed
 * at, so a scenario can have an isolated catalog without a source credential.
 *
 * WHY THIS EXISTS. Four Stripe scenarios (H/L/M/N) need a catalog they can
 * mutate freely - caching fixture tables, refreshing metadata, materializing a
 * query - and must not do any of that to the shared PEAKA_CATALOG_ID that B, C
 * and F are reading from parallel workers. Each therefore created its OWN
 * connection first, which needs STRIPE_TEST_TOKEN, which made a Stripe API key
 * a precondition for scenarios that never call Stripe.
 *
 * A catalog does not need a NEW connection, only A connection - and the
 * project already has one.
 *
 * MEASURED, because the opposite was recorded and mis-attributed. HubSpot's
 * h-catalogs.js documents a real 500 from createCatalog when a second catalog
 * is attached to an already-catalogued connection, reproduced across H/L/M/N -
 * but the variable was the PROJECT, not the connection. The same call returns
 * 500 for every connection in one project (Stripe's included) and 200 for
 * every connection in another. See FINDINGS.md #38.
 * Probed against the live Stripe connection on 2026-08-18:
 *
 *   createCatalog on the existing stripe connection  -> 200
 *   listSchemas on the new catalog                   -> 200  (payment)
 *   listTables                                       -> 200  (113 tables)
 *   SELECT COUNT(*) through it                       -> 200
 *   createCache + poll                               -> COMPLETED
 *   deleteCatalog                                    -> 200
 *
 * So the new catalog is a full peer of the shared one: same contents, same
 * sync behaviour, its own cache namespace. Exactly the isolation those four
 * scenarios wanted, at no credential cost.
 *
 * In a project where createCatalog 500s (FINDINGS.md #38) this fails loudly
 * rather than skipping, and the assertion below names the cause. That is
 * deliberate: a 5xx is a product defect this suite exists to surface, and
 * absorbing it would hide the very thing worth reporting.
 */
async function provisionCatalogOnSharedConnection(ctx, name) {
  const cats = await ctx.client.listCatalogs();
  assertStatus(cats, 200, "listCatalogs (to find the connection behind the shared catalog)");
  const shared = (cats.body || []).find((c) => String(c.id) === String(ctx.catalogId));
  assert(
    shared && shared.connectionId,
    `Could not find a connection for catalog ${ctx.catalogId}. This scenario provisions its own catalog on ` +
      `the connection the suite is already configured against, so that connection has to be discoverable.`
  );

  const res = await ctx.client.createCatalog({ name, connectionId: shared.connectionId });
  assertStatus(
    res,
    200,
    `createCatalog on the existing connection ${shared.connectionId}. If this is a 500, Peaka has started ` +
      `refusing a second catalog per connection for this connector - see this module's header`
  );
  assert(res.body && res.body.id, `Expected a catalog id, got: ${JSON.stringify(res.body)}`);
  ctx.createdCatalogIds.push(res.body.id);

  return { catalogId: res.body.id, catalogName: res.body.name, connectionId: shared.connectionId };
}

module.exports = { provisionCatalogOnSharedConnection };
