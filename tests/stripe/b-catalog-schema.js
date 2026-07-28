const { assertStatus, assert, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");

// Expected minimum columns per table. We check "at least these exist" rather
// than an exact match, since Peaka/Stripe may expose additional fields over
// time. Note: Peaka's Stripe connector flattens nested objects and exposes
// the customer reference as `customer_id`, not `customer` (confirmed against
// a real run's column list on 2026-07-21).
const EXPECTED_COLUMNS = {
  customers: ["id", "email", "name", "created"],
  charges: ["id", "amount", "currency", "status", "customer_id"],
  subscriptions: ["id", "customer_id", "status"],
  invoices: ["id", "customer_id", "status"],
};

/**
 * Catalog & Schema Discovery: a real sequential chain, deliberately kept
 * dependent (see conversation history) - each step needs the previous one's
 * output: read catalog -> discover schema -> discover tables -> check cache
 * flags -> check columns per table.
 */
async function runCatalogSchemaDiscovery(ctx) {
  assert(ctx.catalogId, "Requires PEAKA_CATALOG_ID to be set in .env");

  await step("read pre-existing catalog", async () => {
    await resolveCatalogName(ctx);
  });

  await step("list schemas", async () => {
    const res = await ctx.client.listSchemas(ctx.catalogId);
    assertStatus(res, 200, "listSchemas");
    assert(Array.isArray(res.body) && res.body.length > 0, "Expected at least one schema");
    const schemaNames = res.body.map((s) => (typeof s === "string" ? s : s.schemaName || s.name));

    if (ctx.schemaName) {
      assertIncludes(schemaNames, ctx.schemaName, "discovered schemas");
    }
    // Set (or confirm) ctx.schemaName from the live discovery, for the next steps.
    ctx.schemaName = ctx.schemaName || schemaNames[0];
    assert(ctx.schemaName, "Could not determine a schema name from the discovery or config");
  });

  await step("list tables and check core tables present", async () => {
    const res = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertStatus(res, 200, "listTables");
    const tableNames = res.body.map((t) => t.tableName);
    ctx.tables = res.body; // used by the next step
    ctx.tableNames = tableNames;

    const expectedCore = ["customers", "charges"];
    const missing = expectedCore.filter((t) => !tableNames.includes(t));
    assert(
      missing.length === 0,
      `Expected core tables missing from Stripe catalog: ${missing.join(", ")}. Found: ${tableNames.join(", ")}`
    );
  });

  await step("verify cache capability flags", async () => {
    assert(ctx.tables, "Requires table list from the previous step");
    const customers = ctx.tables.find((t) => t.tableName === "customers");
    assert(customers, "customers table not found");
    assert(customers.isCacheable === true, "Expected customers table to be cacheable");
    assert(
      Array.isArray(customers.supportedCacheTypes) && customers.supportedCacheTypes.length > 0,
      "Expected customers table to support at least one cache type"
    );
  });

  for (const [tableName, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
    await step(`list columns for '${tableName}'`, async () => {
      const res = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, tableName);
      assertStatus(res, 200, `listColumns(${tableName})`);
      const colNames = res.body.map((c) => c.name || c.columnName);
      for (const expected of expectedCols) {
        assertIncludes(colNames, expected, `${tableName} columns`);
      }
    });
  }
}

module.exports = { runCatalogSchemaDiscovery };
