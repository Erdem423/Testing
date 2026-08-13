const { assertStatusIn, assertStatus, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

/**
 * MO-G: Catalog endpoints - the mirror of PG-G, itself the mirror of Stripe's `H`.
 *
 * NEEDS NO DATABASE CREDENTIALS, same reasoning as PG-G: creating a MongoDB
 * connection needs a connection string this suite doesn't hold, so this hangs
 * its throwaway catalog off the EXISTING connection (PEAKA_MONGO_CONNECTION_ID)
 * instead. Verified live that createCatalog against it works fine.
 *
 * THE FINDING HERE IS THE OPPOSITE OF PG-G'S, and that inversion is the whole
 * reason this scenario earns its place rather than being a mechanical copy.
 * PG-G shows table statistics work for Postgres but not Stripe - which reads
 * as "database connectors get it, API connectors don't" UNTIL a second
 * database connector is tried. Measured live against MongoDB:
 *
 *   Stripe    400 "Catalog type: stripe is not being supported yet"
 *   Postgres  200, real per-column statistics
 *   MongoDB   400 "Catalog type: peaka_mongodb is not being supported yet"
 *
 * So the earlier read was wrong: this isn't "database vs API connector", it's
 * "Postgres happens to have it implemented, and nothing else does yet" - a
 * materially different, narrower claim that only a third data point could
 * expose. See FINDINGS 33.
 */
async function runMoCatalogs(ctx) {
  const name = `e2e_auto_mo_catalog_${ctx.runTag}`.replace(/-/g, "_");
  let catalogId = null;
  let table = null;

  await step("discover a collection on the shared catalog", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog (shared)");
    table = await resolveLargeTable(ctx, res.body.name);
  });

  await step("create a catalog on the existing connection", async () => {
    assert(
      ctx.connectionId,
      "Requires PEAKA_MONGO_CONNECTION_ID in .env - this scenario reuses the existing connection rather than " +
        "creating one, so it needs no database credentials."
    );
    const res = await ctx.client.createCatalog({ name, connectionId: ctx.connectionId });
    assertStatus(res, 200, "createCatalog");
    assert(res.body && res.body.id, "Expected a catalog id in the response");
    catalogId = res.body.id;
    ctx.createdCatalogIds.push(catalogId);
  });

  await step("list catalogs includes the new one and the configured one", async () => {
    const res = await ctx.client.listCatalogs();
    assertStatus(res, 200, "listCatalogs");
    assert(Array.isArray(res.body), "Expected an array of catalogs");
    assert(res.body.some((c) => c.id === catalogId), `Newly created catalog ${catalogId} not found in listCatalogs`);
    assert(
      res.body.some((c) => String(c.id) === String(ctx.catalogId)),
      `Configured PEAKA_MONGO_CATALOG_ID (${ctx.catalogId}) not present in listCatalogs - check .env`
    );
  });

  // Same staleness note as PG-G: asserts only that our table is found, not
  // that the result set is clean of deleted throwaway catalogs.
  await step("search finds a collection in the MongoDB catalog", async () => {
    const res = await ctx.client.search({ query: table.tableName, limit: 20 });
    assertStatus(res, 200, "search");
    const tables = res.body.matchedTables || [];
    assert(
      tables.some((t) => t.table === table.tableName),
      `Expected search('${table.tableName}') to match it. Got: ${JSON.stringify(res.body).slice(0, 300)}`
    );

    const stale = tables.filter((t) => /^e2e[_-]/i.test(String(t.catalog || "")));
    if (stale.length > 0) {
      console.log(
        `note: search returned ${stale.length} result(s) from deleted throwaway catalogs ` +
          `(e.g. '${stale[0].catalog}') - the search index lags catalog deletion, same as Postgres.`
      );
    }
  });

  // THE INVERTED ATTRIBUTION STEP - see the module comment. PG-G's equivalent
  // asserts 200 with real statistics; this asserts the SAME rejection Stripe
  // gets. Do not "fix" either side to match the other.
  await step("table statistics are NOT supported for MongoDB, unlike Postgres", async () => {
    const res = await ctx.client.getTableStatistics(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(res, 400, `getTableStatistics(${table.tableName}) on a MongoDB catalog`);
    assert(
      typeof res.body.message === "string" && /not being supported/i.test(res.body.message),
      `Expected an "unsupported" rejection, got: ${JSON.stringify(res.body)}`
    );
    console.log(
      `getTableStatistics -> 400 '${res.body.message}' - same rejection Stripe gets; only Postgres implements it`
    );
  });

  await step("delete the catalog and confirm it is gone", async () => {
    const res = await ctx.client.deleteCatalog(catalogId);
    assertStatusIn(res, [200, 204], "deleteCatalog");
    ctx.createdCatalogIds = ctx.createdCatalogIds.filter((id) => id !== catalogId);

    const list = await ctx.client.listCatalogs();
    assertStatus(list, 200, "listCatalogs after delete");
    assert(!list.body.some((c) => c.id === catalogId), "Deleted catalog still appears in listCatalogs");
    assert(
      list.body.some((c) => String(c.id) === String(ctx.catalogId)),
      "The configured PEAKA_MONGO_CATALOG_ID disappeared - this scenario must only ever delete its own catalog"
    );
  });
}

module.exports = { runMoCatalogs };
