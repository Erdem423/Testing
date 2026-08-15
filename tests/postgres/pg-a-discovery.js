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
    // SURVEYS THE SCHEMA RATHER THAN TRUSTING ONE TABLE. This step used to take
    // the first table it found, which made it hostage to that table's metadata:
    // on the Sakila sample database it landed on `actor`, whose rejection is
    // MALFORMED (see the next step), and a real product claim went red for a
    // reason that had nothing to do with cacheability enforcement.
    //
    // The claim here is "Peaka refuses, and says why". Proving it needs one
    // table that rejects cleanly - and finding that is the discovery job this
    // folder does everywhere else, rather than hardcoding a fixture.
    const tables = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertStatus(tables, 200, "listTables");
    const names = (tables.body || []).map((t) => t.tableName).filter(Boolean);
    assert(names.length > 0, `No tables in '${ctx.schemaName}' to attempt a cache on`);

    const rejections = [];
    let cleanRejection = null;

    for (const tableName of names) {
      const res = await ctx.client.createCache({
        catalogId: ctx.catalogId,
        schemaName: ctx.schemaName,
        tableName,
      });

      // Defensive: if Peaka ever starts allowing this, the cache is real and
      // must be cleaned up. Tracked before asserting so a failure cannot
      // strand it.
      if (res.status === 200 && res.body && res.body.id) {
        ctx.createdCacheIds.push(res.body.id);
      }

      assertNoServerError(res, `createCache(${tableName})`, {
        message: `createCache(${tableName}) returned ${res.status} - a server error, which no input should cause`,
      });
      rejections.push({ tableName, status: res.status, body: res.body || {} });

      if (res.status === 400 && res.body && res.body.errorCode === "TABLE_NOT_CACHEABLE") {
        cleanRejection = tableName;
        break; // one clean rejection is all the enforcement claim needs
      }
    }

    ctx.cacheRejections = rejections;
    assert(
      cleanRejection,
      `No table in '${ctx.schemaName}' produced a proper TABLE_NOT_CACHEABLE rejection. Peaka either stopped ` +
        `enforcing non-cacheability, or every rejection is now malformed. Attempts: ` +
        JSON.stringify(rejections.map((r) => `${r.tableName}=${r.status}/${r.body.errorCode}`))
    );
    console.log(`createCache refused with TABLE_NOT_CACHEABLE on '${cleanRejection}'`);
  });

  // REPORTED, NOT ASSERTED, and deliberately so. A table whose Postgres COMMENT
  // is not valid JSON makes createCache fail with a PARSE error instead of its
  // proper rejection - errorCode null, and the comment echoed back in the
  // message. Measured 2026-08-12 on Sakila: 1 of 28 tables (`actor`, commented
  // "Stores actors appearing in films.").
  //
  // Not asserted because the input is outside this suite's control, and the
  // table/column distinction is what makes it so. COLUMN descriptions ARE
  // readable - listColumns returns a real `desc` for Postgres columns - but
  // TABLE descriptions are not exposed anywhere: listTables has no such field,
  // information_schema.tables carries only catalog/schema/name/type,
  // obj_description('...'::regclass) is rejected by Trino's parser, and
  // pg_description will not resolve. Nor can one be SET (the `desc` field on
  // internal-table columns is silently discarded - see FINDINGS 22).
  //
  // The only reason the offending comment's text is known at all is that this
  // very bug echoes it back. Which tables trigger it therefore depends on
  // someone else's schema, so an assertion here would pass or fail on whose
  // database you point at rather than on anything Peaka did.
  //
  // It also evades the 5xx warning channel completely: Peaka returns 400
  // WrongRequestException, so a genuine server-side crash is labelled a client
  // error and helpers/serverError.js never sees it.
  await step("every cache rejection carries a usable error code", async () => {
    const rejections = ctx.cacheRejections || [];
    const malformed = rejections.filter(
      (r) => r.status === 400 && !r.body.errorCode && String(r.body.message || "").includes("JSON input:")
    );

    for (const r of malformed) {
      const leaked = String(r.body.message).split("JSON input:")[1].trim();
      console.log(`FINDING: '${r.tableName}' rejected with errorCode=null - its description broke a JSON parse: ${leaked}`);
    }
    console.log(
      `OBSERVED: ${rejections.length - malformed.length} of ${rejections.length} attempted rejections carried an errorCode` +
        (malformed.length ? ` - ${malformed.length} did not (see FINDINGS 28)` : "")
    );
  });
}

module.exports = { runPgDiscovery };
