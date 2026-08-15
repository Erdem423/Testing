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
async function resolveCatalogName(ctx) {
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
  assertEqual(res.body.catalogType, ctx.connectorType || "stripe", "catalogType");
  // `name` is the generated queryable slug (used in SQL), distinct from `displayName`.
  ctx.catalogName = res.body.name;
}

module.exports = { resolveCatalogName };
