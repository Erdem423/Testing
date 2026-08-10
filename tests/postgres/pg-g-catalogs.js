const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

/**
 * PG-G: Catalog endpoints - the mirror of Stripe's `H`.
 *
 * NEEDS NO DATABASE CREDENTIALS, unlike its Stripe counterpart. `H` creates
 * its own connection because a Stripe connection only needs a token this suite
 * already holds. Creating a Postgres connection would need url/user/password,
 * so this hangs its throwaway catalog off the EXISTING connection instead
 * (PEAKA_PG_CONNECTION_ID). Verified 2026-08-07 that createCatalog against a
 * pre-existing connection works fine - only PG-E needs real credentials.
 *
 * THE FINDING IS TABLE STATISTICS. Stripe's `H` asserts the endpoint is NOT
 * implemented for its connector - 400 "Catalog type: stripe is not being
 * supported yet". Against Postgres the same call returns 200 with real
 * per-column statistics. So that limitation is connector-specific rather than
 * an unimplemented Peaka feature, which is a materially different thing to
 * report - and neither half says it alone.
 *
 * It never deletes PEAKA_PG_CATALOG_ID. Assertions touching the shared catalog
 * are read-only.
 */
async function runPgCatalogs(ctx) {
  const name = `e2e_auto_pg_catalog_${ctx.runTag}`.replace(/-/g, "_");
  let catalogId = null;
  let table = null;

  await step("discover a table on the shared catalog", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog (shared)");
    table = await resolveLargeTable(ctx, res.body.name);
  });

  await step("create a catalog on the existing connection", async () => {
    assert(
      ctx.connectionId,
      "Requires PEAKA_PG_CONNECTION_ID in .env - this scenario reuses the existing connection rather than " +
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
    // Cheap cross-check that PEAKA_PG_CATALOG_ID refers to something real.
    assert(
      res.body.some((c) => String(c.id) === String(ctx.catalogId)),
      `Configured PEAKA_PG_CATALOG_ID (${ctx.catalogId}) not present in listCatalogs - check .env`
    );
  });

  // ASSERTS ONLY THAT OUR TABLE IS FOUND, deliberately - not that the result
  // set is clean. Peaka's search index is STALE: measured 2026-08-07, it
  // returned catalogs that no longer exist in listCatalogs (deleted throwaway
  // catalogs from earlier runs). Asserting on the shape of the whole result
  // would therefore fail for reasons unrelated to search working.
  await step("search finds a table in the Postgres catalog", async () => {
    const res = await ctx.client.search({ query: table.tableName, limit: 20 });
    assertStatus(res, 200, "search");
    // Unmatched groups come back as null rather than [], so guard.
    const tables = res.body.matchedTables || [];
    assert(
      tables.some((t) => t.table === table.tableName),
      `Expected search('${table.tableName}') to match it. Got: ${JSON.stringify(res.body).slice(0, 300)}`
    );

    const stale = tables.filter((t) => /^e2e[_-]/i.test(String(t.catalog || "")));
    if (stale.length > 0) {
      console.log(
        `note: search returned ${stale.length} result(s) from deleted throwaway catalogs ` +
          `(e.g. '${stale[0].catalog}') - the search index lags catalog deletion.`
      );
    }
  });

  // THE ATTRIBUTION STEP. Stripe's `H` asserts this endpoint 400s with
  // "not being supported yet"; here it works. If Peaka ever implements it for
  // Stripe, that step goes red and this one keeps passing - which is exactly
  // the signal wanted, so do not soften either side.
  await step("table statistics ARE supported for Postgres, unlike Stripe", async () => {
    const res = await ctx.client.getTableStatistics(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(res, 200, `getTableStatistics(${table.tableName}) on a Postgres catalog`);
    assert(
      Array.isArray(res.body.columnStatistics) && res.body.columnStatistics.length > 0,
      `Expected per-column statistics, got: ${JSON.stringify(res.body).slice(0, 300)}`
    );
    for (const stat of res.body.columnStatistics) {
      assert(typeof stat.columnName === "string" && stat.columnName.length > 0, `Statistic with no column name: ${JSON.stringify(stat)}`);
      assert(
        typeof stat.distinctFraction === "number",
        `Expected a numeric distinctFraction for '${stat.columnName}', got: ${JSON.stringify(stat)}`
      );
    }
    console.log(
      `${res.body.columnStatistics.length} column statistics returned - the same call 400s for a Stripe catalog`
    );
  });

  await step("delete the catalog and confirm it is gone", async () => {
    const res = await ctx.client.deleteCatalog(catalogId);
    assertStatusIn(res, [200, 204], "deleteCatalog");
    ctx.createdCatalogIds = ctx.createdCatalogIds.filter((id) => id !== catalogId);

    const list = await ctx.client.listCatalogs();
    assertStatus(list, 200, "listCatalogs after delete");
    assert(!list.body.some((c) => c.id === catalogId), "Deleted catalog still appears in listCatalogs");
    // The configured catalog must be untouched by any of this.
    assert(
      list.body.some((c) => String(c.id) === String(ctx.catalogId)),
      "The configured PEAKA_PG_CATALOG_ID disappeared - this scenario must only ever delete its own catalog"
    );
  });
}

module.exports = { runPgCatalogs };
