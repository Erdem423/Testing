const { assertStatus, assert, assertEqual, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError } = require("../../helpers/serverError");

// A schema with hundreds of collections would otherwise turn this into a long scan.
const MAX_TABLES_TO_PROBE = 25;

/**
 * MO-A: Catalog & Schema Discovery (MongoDB).
 *
 * THE ARCHITECTURE PROOF, a second time. PG-A already exercised config -> ctx
 * -> client -> catalog against a non-Stripe connector; this exercises it
 * against a non-RELATIONAL one. Nothing in buildCtx.js, server.js or
 * helpers/env.js needed to change - the only new code anywhere is this
 * folder plus measureMongoDB() in helpers/preflight.js, which is exactly the
 * "zero core changes" claim tests/postgres/meta.js makes, now checked twice.
 *
 * THREE CONFIRMATIONS, carried over from Postgres and now proven not to be
 * relational-database-specific:
 *
 *   the 100-row cap      -> still CONNECTOR-SPECIFIC (step 5)
 *   cacheability          -> still a property of the connector CLASS,
 *                            enforced with the same clean error (steps 6-7)
 *   string serialization  -> still PLATFORM-WIDE, implicit in every value
 *                            this file reads back as a string
 *
 * ONE NEW FINDING, unique to a document store: MongoDB's `_id` is completely
 * absent from listColumns and from `SELECT *` (steps 8-9), and the naive way
 * of asking for it by name and filtering on it is broken (step 9) - but a
 * working path exists (step 10). See FINDINGS.md.
 *
 * REUSES THE EXISTING CATALOG, same as Postgres. Nothing here creates or
 * deletes anything except the deliberate cache-rejection attempt in step 7,
 * which is defensively tracked for cleanup in case Peaka ever starts allowing it.
 */
async function runMoDiscovery(ctx) {
  let catalogName = null;
  let schemas = [];
  let tableName = null;
  let rowCount = -1;
  let sampleColumn = null;

  await step("read the configured MongoDB catalog", async () => {
    assert(ctx.catalogId, "Requires PEAKA_MONGO_CATALOG_ID in .env");
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog (mongodb)");
    catalogName = res.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(res.body)}`);
    assert(
      String(res.body.catalogType).toLowerCase().includes("mongo"),
      `Expected a mongo catalogType, got '${res.body.catalogType}'. Is PEAKA_MONGO_CATALOG_ID pointing ` +
        `at the right catalog?`
    );
    console.log(`catalog '${catalogName}' (${res.body.catalogType})`);
  });

  await step("list schemas and find the configured one", async () => {
    const res = await ctx.client.listSchemas(ctx.catalogId);
    assertStatus(res, 200, "listSchemas (mongodb)");
    assert(Array.isArray(res.body), "Expected an array of schemas");
    schemas = res.body.map((s) => s.schemaName);
    assertIncludes(schemas, ctx.schemaName, "mongodb schemas");
    // Each Mongo "schema" Peaka reports is one Mongo DATABASE, not a
    // namespace within one - a structural difference from Postgres worth
    // printing rather than asserting on (the count is whatever this
    // connection happens to have).
    console.log(`${schemas.length} schema(s) (= Mongo databases): ${schemas.join(", ")}`);
  });

  await step("list tables in the configured schema, and discover one to query", async () => {
    const res = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertStatus(res, 200, `listTables(${ctx.schemaName})`);
    const names = (res.body || []).map((t) => t.tableName).filter(Boolean);
    assert(names.length > 0, `Schema '${ctx.schemaName}' has no collections - nothing to discover`);
    ctx.tables = res.body;

    let best = null;
    let bestCount = -1;
    for (const name of names.slice(0, MAX_TABLES_TO_PROBE)) {
      const cnt = await ctx.client.executeQuery(
        { statement: `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${ctx.schemaName}"."${name}"` },
        "SIMPLE"
      );
      assertStatus(cnt, 200, `COUNT(*) on ${name}`);
      const n = Number(cnt.body.data[0].cnt);
      if (n > bestCount) {
        bestCount = n;
        best = name;
      }
    }
    tableName = best;
    rowCount = bestCount;
    console.log(`${names.length} collection(s); largest is '${tableName}' (${rowCount} rows)`);
  });

  await step("columns on the collection carry real declared types", async () => {
    const res = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, tableName);
    assertStatus(res, 200, `listColumns(${tableName})`);
    assert(Array.isArray(res.body) && res.body.length > 0, `Expected columns on '${tableName}'`);
    for (const c of res.body) {
      assert(
        typeof c.dataType === "string" && c.dataType.length > 0,
        `Column '${c.name}' reports no declared type: ${JSON.stringify(c)}`
      );
    }
    sampleColumn = res.body.find((c) => c.name !== "_id") || res.body[0];
    console.log(`${res.body.length} columns, all with declared types (e.g. '${sampleColumn.name}': ${sampleColumn.dataType})`);
  });

  // CONFIRMATION 1/3. Mirrors PG-B's cap-uncapped check without needing the
  // full numeric/text classification machinery that scenario has - one LIMIT
  // past 100 is enough to prove the point for a first scenario.
  await step("querying past 100 rows is not capped, unlike Stripe", async () => {
    assert(
      rowCount > 100,
      `'${tableName}' has only ${rowCount} rows - too few to distinguish "uncapped" from "capped at 100"`
    );
    const res = await ctx.client.executeQuery(
      {
        statement:
          `SELECT COUNT(*) AS cnt FROM (SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${tableName}" ` +
          `LIMIT 150) t`,
      },
      "SIMPLE"
    );
    assertStatus(res, 200, "LIMIT 150 count");
    assertEqual(Number(res.body.data[0].cnt), 150, "rows returned by a LIMIT 150 query");
    console.log(`LIMIT 150 returned all 150 rows - the 100-row live cap does not apply to MongoDB either`);
  });

  // CONFIRMATION 2/3, the metadata half.
  await step("no MongoDB collection is cacheable, in any schema", async () => {
    let total = 0;
    const cacheable = [];
    for (const schemaName of schemas) {
      const res = await ctx.client.listTables(ctx.catalogId, schemaName);
      assertNoServerError(res, "listTables", {
        message: `listTables(${schemaName}) returned ${res.status} - a server error`,
      });
      if (res.status !== 200 || !Array.isArray(res.body)) continue;
      total += res.body.length;
      for (const t of res.body) {
        if (t.isCacheable) cacheable.push(`${schemaName}.${t.tableName}`);
        if (!t.isCacheable) {
          assertEqual(
            (t.supportedCacheTypes || []).length,
            0,
            `${schemaName}.${t.tableName} reports isCacheable:false but lists cache types`
          );
        }
      }
    }
    console.log(`${total} collection(s) across ${schemas.length} schema(s), ${cacheable.length} cacheable`);
    assert(
      cacheable.length === 0,
      `Expected NO cacheable collections on a MongoDB connector, but found ${cacheable.length}: ` +
        `${cacheable.slice(0, 5).join(", ")}. If Peaka has started caching MongoDB this is good news - ` +
        `update this assertion, tests/mongodb/config.js's supportsCaching, and FINDINGS.md.`
    );
  });

  // CONFIRMATION 2/3, the enforcement half.
  await step("creating a cache on a MongoDB collection is refused", async () => {
    const res = await ctx.client.createCache({
      catalogId: ctx.catalogId,
      schemaName: ctx.schemaName,
      tableName,
    });
    if (res.status === 200 && res.body && res.body.id) {
      ctx.createdCacheIds.push(res.body.id);
    }
    assertNoServerError(res, `createCache(${tableName})`, {
      message: `createCache(${tableName}) returned ${res.status} - a server error, which no input should cause`,
    });
    assertStatus(res, 400, `createCache(${tableName})`);
    assertEqual(res.body.errorCode, "TABLE_NOT_CACHEABLE", `createCache(${tableName}) errorCode`);
    console.log(`createCache refused '${tableName}' with a clean TABLE_NOT_CACHEABLE - same as Postgres`);
  });

  // THE NEW FINDING, part 1: invisible.
  await step("_id is completely absent from listColumns and from SELECT *", async () => {
    const cols = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, tableName);
    assertStatus(cols, 200, `listColumns(${tableName})`);
    assert(
      !cols.body.some((c) => c.name === "_id"),
      `Expected '_id' to be absent from listColumns(${tableName}), but it was there. Has Peaka started ` +
        `exposing Mongo's real primary key? If so this finding is stale - see FINDINGS.md.`
    );

    const star = await ctx.client.executeQuery(
      { statement: `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${tableName}" LIMIT 1` },
      "SIMPLE"
    );
    assertStatus(star, 200, "SELECT *");
    assert(
      !Object.prototype.hasOwnProperty.call(star.body.data[0], "_id"),
      `Expected 'SELECT *' to omit _id, but it was in the row: ${JSON.stringify(star.body.data[0])}`
    );
    console.log(`FINDING: '_id' is in neither listColumns(${tableName}) nor 'SELECT *' - it is fully hidden`);
  });

  // THE NEW FINDING, part 2: present but broken when asked for directly.
  await step("_id is selectable by name, but the obvious ways to use it fail", async () => {
    const row = await ctx.client.executeQuery(
      {
        statement:
          `SELECT _id, "${sampleColumn.name}" FROM "${catalogName}"."${ctx.schemaName}"."${tableName}" LIMIT 1`,
      },
      "SIMPLE"
    );
    assertStatus(row, 200, "SELECT _id explicitly");
    const rawId = row.body.data[0]._id;
    assert(typeof rawId === "string" && rawId.length > 0, `Expected a non-empty _id, got: ${JSON.stringify(rawId)}`);
    // Trino's default VARBINARY rendering: hex byte pairs joined by spaces,
    // e.g. "6a 4c 8d 06 ..." - not the 24-char hex string any Mongo tool
    // would recognise as an ObjectId. A caller who selects _id without
    // knowing to CAST it gets something unusable.
    assert(
      rawId.includes(" "),
      `Expected the raw _id to look like space-separated hex bytes (Trino's default VARBINARY ` +
        `rendering), but got '${rawId}' - has Peaka started returning a normal ObjectId string? If so ` +
        `this finding is stale.`
    );

    const naive = await ctx.client.executeQuery(
      {
        statement:
          `SELECT "${sampleColumn.name}" FROM "${catalogName}"."${ctx.schemaName}"."${tableName}" ` +
          `WHERE _id = '${rawId.replace(/ /g, "")}'`,
      },
      "SIMPLE"
    );
    assertNoServerError(naive, "naive _id filter", {
      message: `WHERE _id = '<hex>' returned ${naive.status} - a server error, not the type-mismatch this pins`,
    });
    assert(
      naive.status === 400,
      `Expected the naive 'WHERE _id = <hex string>' to be rejected (type mismatch: the declared type is a ` +
        `distinct ObjectId, not varchar/varbinary), but got ${naive.status}: ${JSON.stringify(naive.body)}. ` +
        `If this now succeeds, the finding is stale.`
    );
    console.log(
      `FINDING: raw _id renders as unusable hex bytes ('${rawId}'), and 'WHERE _id = <hex>' is rejected ` +
        `(${naive.status}: ${JSON.stringify(naive.body).slice(0, 120)})`
    );
  });

  // THE WORKING PATH, so this scenario documents an answer, not just a wall.
  await step("CAST(_id AS VARCHAR) and objectid(hex) are the working escape hatch", async () => {
    const row = await ctx.client.executeQuery(
      {
        statement:
          `SELECT CAST(_id AS VARCHAR) AS id_hex, "${sampleColumn.name}" AS anchor FROM ` +
          `"${catalogName}"."${ctx.schemaName}"."${tableName}" LIMIT 1`,
      },
      "SIMPLE"
    );
    assertStatus(row, 200, "SELECT CAST(_id AS VARCHAR)");
    const idHex = row.body.data[0].id_hex;
    const anchorValue = row.body.data[0].anchor;
    assert(
      /^[0-9a-f]{24}$/i.test(idHex),
      `Expected CAST(_id AS VARCHAR) to yield a standard 24-char hex ObjectId, got '${idHex}'`
    );

    const filtered = await ctx.client.executeQuery(
      {
        statement:
          `SELECT "${sampleColumn.name}" AS anchor FROM "${catalogName}"."${ctx.schemaName}"."${tableName}" ` +
          `WHERE _id = objectid('${idHex}')`,
      },
      "SIMPLE"
    );
    assertStatus(filtered, 200, "WHERE _id = objectid(hex)");
    assert(filtered.body.data.length > 0, `objectid('${idHex}') matched no row - expected the same row back`);
    assertEqual(
      String(filtered.body.data[0].anchor),
      String(anchorValue),
      `row selected by objectid('${idHex}') vs the row CAST(_id AS VARCHAR) was read from`
    );
    console.log(`WORKAROUND CONFIRMED: CAST(_id AS VARCHAR) -> '${idHex}', and WHERE _id = objectid('${idHex}') round-trips to the same row`);
  });
}

module.exports = { runMoDiscovery };
