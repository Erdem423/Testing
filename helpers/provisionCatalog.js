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
 * MEASURED, because the opposite was recorded for HubSpot and assumed general.
 * tests/hubspot/h-catalogs.js documents Peaka returning a real 500 on
 * createCatalog when a second catalog is attached to a connection that already
 * has one, reproduced across H/L/M/N, and a helper implementing this approach
 * was deleted as unworkable. That is a HubSpot behaviour, not a Peaka rule.
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
 * If Peaka ever starts refusing this for Stripe too, these scenarios should go
 * back to creating their own connection and gate on
 * tests/stripe/checkTokenCredentials.js again - the assertion below will say
 * so rather than failing somewhere deeper.
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
