const { assertStatus, assert, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");

// Expected minimum columns per table. UNLIKE the Stripe version of this file,
// only "id" is asserted here - real column names have NOT been confirmed
// against a live listColumns(catalogId, "crm", tableName) call yet - no
// HubSpot credentials were available while this was written. Once real data
// is visible, widen
// this the same way tests/stripe/b-catalog-schema.js does - e.g. contacts
// likely exposes something like email/firstname/lastname, companies likely
// exposes name/domain, deals likely exposes dealname/amount/dealstage - but
// don't hardcode those without checking, Peaka may flatten HubSpot's
// properties differently than the raw HubSpot API does (it flattened
// Stripe's nested `customer` into `customer_id`, for example).
const EXPECTED_COLUMNS = {
  contacts: ["id"],
  companies: ["id"],
  deals: ["id"],
};

/**
 * Catalog & Schema Discovery, HubSpot version of tests/stripe/b-catalog-schema.js.
 *
 * HubSpot's catalog exposes multiple schemas (conversations, crm,
 * crm_associations, scheduler, settings - confirmed via Peaka Studio), unlike
 * Stripe's single "payment" schema. This scenario is scoped to the "crm"
 * schema (PEAKA_HUBSPOT_SCHEMA_NAME default), which is where the core
 * contacts/companies/deals data lives - the other schemas are out of scope
 * for now, same as how this suite never touched Stripe's non-payment data.
 *
 * Same real sequential chain as the Stripe version, deliberately kept
 * dependent: read catalog -> discover schema -> discover tables -> check
 * cache flags -> check columns per table.
 */
async function runCatalogSchemaDiscovery(ctx) {
  assert(ctx.catalogId, "Requires PEAKA_HUBSPOT_CATALOG_ID to be set in .env");

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
    ctx.schemaName = ctx.schemaName || schemaNames[0];
    assert(ctx.schemaName, "Could not determine a schema name from the discovery or config");
  });

  await step("list tables and check core tables present", async () => {
    const res = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertStatus(res, 200, "listTables");
    const tableNames = res.body.map((t) => t.tableName);
    ctx.tables = res.body;
    ctx.tableNames = tableNames;

    // "*_search" entries seen in Peaka Studio (companies_search, etc.) render
    // with a different icon there (function-style, not a plain table) - if
    // they show up here too they are NOT expected to behave like ordinary
    // cacheable tables, so they're deliberately excluded from this check.
    const expectedCore = ["contacts", "companies"];
    const missing = expectedCore.filter((t) => !tableNames.includes(t));
    assert(
      missing.length === 0,
      `Expected core tables missing from HubSpot catalog: ${missing.join(", ")}. Found: ${tableNames.join(", ")}`
    );
  });

  await step("verify cache capability flags", async () => {
    assert(ctx.tables, "Requires table list from the previous step");
    const contacts = ctx.tables.find((t) => t.tableName === "contacts");
    assert(contacts, "contacts table not found");
    assert(contacts.isCacheable === true, "Expected contacts table to be cacheable");
    assert(
      Array.isArray(contacts.supportedCacheTypes) && contacts.supportedCacheTypes.length > 0,
      "Expected contacts table to support at least one cache type"
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
      // Logged (not asserted) so a real run reveals the full column set,
      // which is what EXPECTED_COLUMNS above should be widened with next.
      console.log(`${tableName} columns (widen EXPECTED_COLUMNS with these): ${colNames.join(", ")}`);
    });
  }
}

module.exports = { runCatalogSchemaDiscovery };
