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
    // getCatalog's path is best-effort (see peakaClient.js header) - if it
    // doesn't match your Peaka instance, fall back to the queryable name you
    // provided directly via PEAKA_CATALOG_NAME in .env rather than
    // hard-failing over an unconfirmed endpoint path.
    ctx.catalogName = ctx.catalogNameFromConfig;
    return;
  }

  assertStatus(res, 200, "getCatalog");
  assert(res.body && res.body.name, "Expected catalog response to include a queryable name");
  assertEqual(res.body.catalogType, "stripe", "catalogType");
  // `name` is the generated queryable slug (used in SQL), distinct from `displayName`.
  ctx.catalogName = res.body.name;
}

module.exports = { resolveCatalogName };
