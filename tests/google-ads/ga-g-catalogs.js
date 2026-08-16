const { assertStatus, assert } = require("../../helpers/assert");
const { resolveLargeTable } = require("./fixture");
const { step } = require("../../helpers/step");

/**
 * GA-G: Catalog endpoints - the mirror of MO-G/PG-G, itself the mirror of
 * Stripe's `H` - but DELIBERATELY SCOPED DOWN.
 *
 * PG-G and MO-G both create a throwaway catalog on the existing connection
 * with just `{ name, connectionId }`. Measured live against Google Ads:
 *
 *   POST /catalogs { name, connectionId: "<gads connection>" }
 *   -> 400 "Fields [customerUnderscoreSecret, secret, token] are required
 *      for type with serial name 'GOOGLE_ADS', but they were missing"
 *
 * Unlike Postgres and MongoDB, reusing an EXISTING Google Ads connection is
 * not enough to create a NEW catalog on it - Peaka wants the OAuth client
 * secret and refresh token re-supplied at catalog-creation time, which this
 * suite was never given (same reason there is no GA-E connection-lifecycle
 * scenario). So this scenario keeps only the two assertions that don't need
 * a throwaway catalog - search, and the table-statistics attribution - and
 * skips catalog create/list/delete entirely rather than pretending they can
 * be tested without real OAuth credentials.
 *
 * THE ATTRIBUTION STEP mirrors MO-G's, not PG-G's: table statistics turn out
 * to be Postgres-only (finding 33), and Google Ads gets the exact same
 * "not being supported yet" rejection Stripe and MongoDB do - a fourth
 * connector agreeing.
 */
async function runGaCatalogs(ctx) {
  let catalogName = null;
  let table = null;

  await step("discover a table on the shared catalog", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog (shared)");
    catalogName = res.body.name;
    table = await resolveLargeTable(ctx, catalogName);
  });

  // Same staleness note as PG-G/MO-G: asserts only that our table is found.
  await step("search finds a table in the Google Ads catalog", async () => {
    const res = await ctx.client.search({ query: table.tableName, limit: 20 });
    assertStatus(res, 200, "search");
    const tables = res.body.matchedTables || [];
    assert(
      tables.some((t) => t.table === table.tableName),
      `Expected search('${table.tableName}') to match it. Got: ${JSON.stringify(res.body).slice(0, 300)}`
    );
  });

  // THE INVERTED ATTRIBUTION STEP - see the module comment. PG-G's
  // equivalent asserts 200 with real statistics; this asserts the SAME
  // rejection Stripe and MongoDB get. Do not "fix" either side to agree.
  await step("table statistics are NOT supported for Google Ads, unlike Postgres", async () => {
    const res = await ctx.client.getTableStatistics(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(res, 400, `getTableStatistics(${table.tableName}) on a Google Ads catalog`);
    assert(
      typeof res.body.message === "string" && /not being supported/i.test(res.body.message),
      `Expected an "unsupported" rejection, got: ${JSON.stringify(res.body)}`
    );
    console.log(`getTableStatistics -> 400 '${res.body.message}' - same rejection Stripe/MongoDB get; only Postgres implements it`);
  });
}

module.exports = { runGaCatalogs };
