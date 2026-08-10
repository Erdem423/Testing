const { assertStatus, assert, assertEqual, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError } = require("../../helpers/serverError");
const { resolveLargeTable, classifyColumns } = require("./fixture");

/**
 * PG-A: Catalog & Schema Discovery.
 *
 * The Stripe equivalent of this is `B`, and structurally they are the same
 * walk: catalog -> schemas -> tables -> columns. Two things make this one worth
 * having rather than a copy.
 *
 * FIRST, IT IS THE ARCHITECTURE PROOF. The repo has long claimed a new
 * connector needs "zero core changes" because server.js discovers any
 * tests/<name>/ folder with a meta.js. That claim was never tested, and turned
 * out to be half true - the framework was connector-agnostic, the config layer
 * was not (helpers/env.js required STRIPE_TEST_TOKEN of everybody). This
 * scenario exercises the whole config -> ctx -> client -> catalog path against
 * a non-Stripe connector, which is what the claim actually rests on.
 *
 * SECOND, IT PINS A FINDING. Every table here reports isCacheable: false, and
 * that is a property of the connector CLASS, not this database:
 *
 *   Postgres  0 of 40 tables cacheable, across 10 schemas
 *   MongoDB   0 of 2
 *   createCache is enforced -> 400 TABLE_NOT_CACHEABLE
 *
 * Peaka's cache exists to escape slow, paginated remote APIs; Trino queries a
 * database directly, so there is nothing to escape. Asserting it means a future
 * Peaka release that starts caching databases shows up as a failure here rather
 * than as a surprise - and it is the reason C, M, O and all four race tiers
 * have no Postgres counterpart.
 *
 * REUSES THE EXISTING CATALOG. Nothing here creates or deletes anything, so
 * there is nothing to clean up.
 */
async function runPgDiscovery(ctx) {
  let catalogName = null;
  let schemas = [];
  // Discovered rather than declared - config.js used to name `e_commerce` and
  // `users`, which tied this folder to one database. See ./fixture.js.
  let table = null;
  let anyTableName = null;

  await step("read the configured Postgres catalog", async () => {
    assert(ctx.catalogId, "Requires PEAKA_PG_CATALOG_ID in .env");
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog (postgres)");
    catalogName = res.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(res.body)}`);

    // Note the type: `peaka_postgres`, distinct from Stripe's `stripe`. The
    // connector CONFIG carries no capability flags at all - no cache or sync
    // declaration for either connector - so cacheability is only discoverable
    // per-table, which is what the step below does.
    assert(
      String(res.body.catalogType).toLowerCase().includes("postgres"),
      `Expected a postgres catalogType, got '${res.body.catalogType}'. Is PEAKA_PG_CATALOG_ID pointing ` +
        `at the right catalog?`
    );
    console.log(`catalog '${catalogName}' (${res.body.catalogType})`);
  });

  await step("list schemas and find the configured one", async () => {
    const res = await ctx.client.listSchemas(ctx.catalogId);
    assertStatus(res, 200, "listSchemas (postgres)");
    assert(Array.isArray(res.body), "Expected an array of schemas");
    schemas = res.body.map((s) => s.schemaName);
    assertIncludes(schemas, ctx.schemaName, "postgres schemas");
    console.log(`${schemas.length} schemas: ${schemas.join(", ")}`);
  });

  await step("list tables in the configured schema", async () => {
    const res = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertStatus(res, 200, "listTables (postgres)");
    const names = res.body.map((t) => t.tableName).filter(Boolean);
    assert(names.length > 0, `Schema '${ctx.schemaName}' has no tables - nothing to discover`);
    ctx.tables = res.body;
    anyTableName = names[0];
    table = await resolveLargeTable(ctx, catalogName);
    console.log(`${names.length} tables; largest is '${table.tableName}' (${table.rowCount} rows)`);
  });

  await step("columns on the large table carry real declared types", async () => {
    const res = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(res, 200, `listColumns(${table.tableName})`);
    assert(Array.isArray(res.body) && res.body.length > 0, `Expected columns on '${table.tableName}'`);

    // ASSERTS THE SHAPE, NOT SPECIFIC NAMES. This used to require exactly
    // id/age/amount/country with exactly bigint/bigint/double/varchar, which
    // only held for one database. What the scenario actually needs to prove is
    // that Peaka reports Postgres's REAL declared types - even though the
    // VALUES come back as strings (see pg-b-data-correctness.js). The
    // declared/delivered mismatch is a platform-wide convention, not a Postgres
    // quirk, and this is the half proving the metadata side is right.
    for (const c of res.body) {
      assert(
        typeof c.dataType === "string" && c.dataType.length > 0,
        `Column '${c.name}' reports no declared type: ${JSON.stringify(c)}`
      );
    }

    const { numeric, text } = classifyColumns(res.body);
    assert(
      numeric.length > 0,
      `'${table.tableName}' declares no numeric column (types seen: ` +
        `${res.body.map((c) => c.dataType).join(", ")}). pg-b needs one to aggregate.`
    );
    assert(
      text.length > 0,
      `'${table.tableName}' declares no text column (types seen: ${res.body.map((c) => c.dataType).join(", ")}).`
    );
    console.log(
      `${res.body.length} columns, all with declared types ` +
        `(${numeric.length} numeric, ${text.length} text)`
    );
  });

  // THE FINDING, PINNED. See the module comment for why this is a property of
  // the connector class rather than of this particular database.
  await step("no Postgres table is cacheable, in any schema", async () => {
    let total = 0;
    const cacheable = [];

    for (const schemaName of schemas) {
      const res = await ctx.client.listTables(ctx.catalogId, schemaName);
      // pg_catalog and friends can legitimately refuse listing; only a 5xx is
      // a problem here.
      assertNoServerError(res, "listTables", {
        message: `listTables(${schemaName}) returned ${res.status} - a server error`,
      });
      if (res.status !== 200 || !Array.isArray(res.body)) continue;

      total += res.body.length;
      for (const t of res.body) {
        if (t.isCacheable) cacheable.push(`${schemaName}.${t.tableName}`);
        // The two fields must agree - a table advertising cache types while
        // reporting isCacheable:false would be a contradiction worth catching.
        if (!t.isCacheable) {
          assertEqual(
            (t.supportedCacheTypes || []).length,
            0,
            `${schemaName}.${t.tableName} reports isCacheable:false but lists cache types`
          );
        }
      }
    }

    console.log(`${total} tables across ${schemas.length} schemas, ${cacheable.length} cacheable`);
    assert(
      cacheable.length === 0,
      `Expected NO cacheable tables on a database connector, but found ${cacheable.length}: ` +
        `${cacheable.slice(0, 5).join(", ")}. If Peaka has started caching databases this is good news - ` +
        `update this assertion, tests/postgres/config.js's supportsCaching, and FINDINGS.md, because the ` +
        `cache scenarios and race tiers would then apply here too.`
    );
  });

  // The enforcement half. The metadata says non-cacheable; this proves Peaka
  // acts on it rather than merely advertising it - a flag can be stale, a
  // rejection cannot.
  await step("creating a cache on a Postgres table is refused", async () => {
    // Any real table proves the point; no need for a specific one.
    const targetTable = anyTableName;
    const res = await ctx.client.createCache({
      catalogId: ctx.catalogId,
      schemaName: ctx.schemaName,
      tableName: targetTable,
    });

    // Defensive: if Peaka ever starts allowing this, the cache is real and must
    // be cleaned up. Tracked before asserting so a failure cannot strand it.
    if (res.status === 200 && res.body && res.body.id) {
      ctx.createdCacheIds.push(res.body.id);
    }

    assertStatus(res, 400, `createCache(${targetTable}) on a database connector`);
    assertEqual(res.body.errorCode, "TABLE_NOT_CACHEABLE", "rejection errorCode");
    console.log(`createCache refused: ${res.body.errorCode}`);
  });
}

module.exports = { runPgDiscovery };
