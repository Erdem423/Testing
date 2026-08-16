const { assertStatus, assert, assertEqual } = require("./assert");

/**
 * Resolves ctx.catalogName (the queryable SQL slug) if it isn't already set.
 * Calls getCatalog live; falls back to ctx.catalogNameFromConfig
 * (PEAKA_CATALOG_NAME in .env) if that call fails.
 *
 * Any test that needs ctx.catalogName for building SQL queries (currently:
 * B, C, F) should call this itself rather than assuming another test already
 * populated it - each test builds its own independent ctx (see
 * jest/stripe-connector.test.js), so nothing is shared between them.
 */
async function resolveCatalogName(ctx, { expectedCatalogType } = {}) {
  if (ctx.catalogName) return; // already resolved (e.g. called twice, or set some other way)

  assert(ctx.catalogId, "Requires PEAKA_CATALOG_ID to be set in .env");
  const res = await ctx.client.getCatalog(ctx.catalogId);

  if (!res.ok && ctx.catalogNameFromConfig) {
    // Fall back to the queryable name provided directly via
    // PEAKA_CATALOG_NAME in .env rather than hard-failing.
    //
    // NOTE: this fallback originally existed because getCatalog's path was
    // unverified and a failure might have just meant "wrong path". That path
    // is confirmed correct now, so a non-ok response here means something
    // genuinely wrong (bad PEAKA_CATALOG_ID, auth, etc.) - and this fallback
    // will quietly paper over it whenever PEAKA_CATALOG_NAME happens to be
    // set. Worth reconsidering; left in place deliberately for now rather
    // than changing test behavior as a drive-by.
    ctx.catalogName = ctx.catalogNameFromConfig;
    return;
  }

  assertStatus(res, 200, "getCatalog");
  assert(res.body && res.body.name, "Expected catalog response to include a queryable name");
  // The catalog being resolved is USUALLY the ctx's own connector's, so
  // ctx.connectorId is the right default - but not always, and assuming it
  // made one scenario permanently red. tests/peaka-tables/federated-join-cap.js
  // deliberately borrows the STRIPE catalog into a peaka-tables ctx (the whole
  // point of a federated join is spanning two connectors), so this asserted
  // that Stripe's catalog was of type "peaka-tables" - a type no catalog can
  // ever have - and failed every single run.
  //
  // A caller that knowingly resolves another connector's catalog says so.
  assertEqual(res.body.catalogType, expectedCatalogType || ctx.connectorId || "stripe", "catalogType");
  // `name` is the generated queryable slug (used in SQL), distinct from `displayName`.
  ctx.catalogName = res.body.name;
}

module.exports = { resolveCatalogName };
