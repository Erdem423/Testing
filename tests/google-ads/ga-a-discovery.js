const { assertStatus, assert, assertEqual, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError } = require("../../helpers/serverError");
const { resolveLargeTable, withRetry } = require("./fixture");

/**
 * GA-A: Catalog & Schema Discovery (Google Ads).
 *
 * THE FOURTH CONNECTOR, and the first one outside the main Peaka project -
 * see tests/google-ads/config.js for why (a separate project, separate API
 * key) and helpers/env.js's checkCredentials() for the apiKeyEnv/projectIdEnv
 * mechanism that made it a config change rather than a framework one.
 *
 * TWO CONFIRMATIONS, carried over a fourth time:
 *
 *   the 100-row cap   -> still CONNECTOR-SPECIFIC (step 4)
 *   cacheability       -> still a property of the connector CLASS, enforced
 *                         with the same clean 400 TABLE_NOT_CACHEABLE
 *                         Postgres and MongoDB get (steps 5-6)
 *
 * ONE THING GENUINELY DIFFERENT: this connector is measurably flaky. The same
 * query against the same table returns the correct rows most of the time, an
 * empty 200 sometimes, and once (measured live) an outright 400 - with no
 * pattern found across column selection, ORDER BY, or table. That is the same
 * family of problem FINDINGS already records for exports ("fail
 * intermittently... worth re-running once before being believed"), not a
 * deterministic bug, so every row-fetching step here retries through
 * ./fixture.js's withRetry rather than asserting on a single attempt.
 *
 * ONE CONNECTOR QUIRK WORTH RECORDING, not asserting: every table in this
 * catalog - all 150+ of them, the full Google Ads Query Language resource
 * schema - carries a set of `_q_*` columns (pagination_anchor, customer_id,
 * limit, offset, query, page_size, ...) alongside its real data columns.
 * These are GAQL request parameters, not response data - selecting one always
 * returns null. listColumns does not distinguish them from real columns in
 * any structured way; only the naming convention does.
 *
 * REUSES THE EXISTING "gads" CONNECTION. Nothing here creates or deletes
 * anything except the deliberate cache-rejection attempt, defensively tracked
 * in case Peaka ever starts allowing it.
 */
async function runGaDiscovery(ctx) {
  let catalogName = null;
  let schemas = [];
  let table = null;

  await step("read the configured Google Ads catalog", async () => {
    assert(ctx.catalogId, "Requires PEAKA_GOOGLE_ADS_CATALOG_ID in .env");
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog (google-ads)");
    catalogName = res.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(res.body)}`);
    assert(
      String(res.body.catalogType).toLowerCase().includes("google_ads"),
      `Expected a google_ads catalogType, got '${res.body.catalogType}'. Is PEAKA_GOOGLE_ADS_CATALOG_ID ` +
        `pointing at the right catalog?`
    );
    console.log(`catalog '${catalogName}' (${res.body.catalogType})`);
  });

  await step("list schemas and find the configured one", async () => {
    const res = await ctx.client.listSchemas(ctx.catalogId);
    assertStatus(res, 200, "listSchemas (google-ads)");
    assert(Array.isArray(res.body), "Expected an array of schemas");
    schemas = res.body.map((s) => s.schemaName);
    assertIncludes(schemas, ctx.schemaName, "google-ads schemas");
    console.log(`${schemas.length} schema(s): ${schemas.join(", ")}`);
  });

  await step("list tables and discover one with real data to query", async () => {
    const res = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertStatus(res, 200, `listTables(${ctx.schemaName})`);
    const names = (res.body || []).map((t) => t.tableName).filter(Boolean);
    // 150+, the full GAQL resource schema regardless of what the account
    // actually holds - see the module comment. Not asserted to an exact
    // count, since that count is a Peaka/Google Ads product detail, not
    // something this account's data could ever change.
    assert(names.length > 100, `Expected the full Google Ads resource schema (100+ tables), got ${names.length}`);

    table = await resolveLargeTable(ctx, catalogName);
    console.log(`${names.length} tables in the schema; using '${table.tableName}' (${table.rowCount} rows, via ${table.source})`);
  });

  await step("columns on the table carry real declared types", async () => {
    const res = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(res, 200, `listColumns(${table.tableName})`);
    assert(Array.isArray(res.body) && res.body.length > 0, `Expected columns on '${table.tableName}'`);
    for (const c of res.body) {
      assert(
        typeof c.dataType === "string" && c.dataType.length > 0,
        `Column '${c.name}' reports no declared type: ${JSON.stringify(c)}`
      );
    }
    const queryParamColumns = res.body.filter((c) => c.name.startsWith("_q_"));
    console.log(
      `${res.body.length} columns (${queryParamColumns.length} are '_q_*' GAQL request parameters, not data)`
    );
  });

  // CONFIRMATION 1/2. Retried, per the module comment - a single empty
  // result here is Google Ads flakiness, not evidence the cap applies.
  await step("querying past 100 rows is not capped, unlike Stripe", async () => {
    assert(
      table.rowCount > 100,
      `'${table.tableName}' has only ${table.rowCount} rows - too few to distinguish "uncapped" from "capped at 100"`
    );
    const result = await withRetry(async () => {
      const res = await ctx.client.executeQuery(
        {
          statement:
            `SELECT COUNT(*) AS cnt FROM (SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}" ` +
            `LIMIT 150) t`,
        },
        "SIMPLE"
      );
      assertStatus(res, 200, "LIMIT 150 count");
      const empty = !res.body.data || res.body.data.length === 0;
      return { empty, value: empty ? null : Number(res.body.data[0].cnt) };
    }, "LIMIT 150 count");
    assertEqual(result.value, 150, "rows returned by a LIMIT 150 query");
    console.log(`LIMIT 150 returned all 150 rows - the 100-row live cap does not apply to Google Ads either`);
  });

  // CONFIRMATION 2/2, the metadata half.
  await step("no Google Ads table is cacheable, in the schema this run touches", async () => {
    const res = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
    assertNoServerError(res, "listTables", {
      message: `listTables(${ctx.schemaName}) returned ${res.status} - a server error`,
    });
    assertStatus(res, 200, "listTables");
    const cacheable = (res.body || []).filter((t) => t.isCacheable);
    console.log(`${(res.body || []).length} tables, ${cacheable.length} cacheable`);
    assert(
      cacheable.length === 0,
      `Expected NO cacheable tables on a Google Ads connector, but found ${cacheable.length}: ` +
        `${cacheable.slice(0, 5).map((t) => t.tableName).join(", ")}. If Peaka has started caching Google ` +
        `Ads, update this assertion, tests/google-ads/config.js's supportsCaching, and FINDINGS.md.`
    );
  });

  // The enforcement half.
  await step("creating a cache on a Google Ads table is refused", async () => {
    const res = await ctx.client.createCache({
      catalogId: ctx.catalogId,
      schemaName: ctx.schemaName,
      tableName: table.tableName,
    });
    if (res.status === 200 && res.body && res.body.id) {
      ctx.createdCacheIds.push(res.body.id);
    }
    assertNoServerError(res, `createCache(${table.tableName})`, {
      message: `createCache(${table.tableName}) returned ${res.status} - a server error, which no input should cause`,
    });
    assertStatus(res, 400, `createCache(${table.tableName})`);
    assertEqual(res.body.errorCode, "TABLE_NOT_CACHEABLE", `createCache(${table.tableName}) errorCode`);
    console.log(`createCache refused '${table.tableName}' with a clean TABLE_NOT_CACHEABLE - same as Postgres and MongoDB`);
  });

  // REPORTED, not asserted - see the module comment for why a single
  // occurrence of either shape is expected flakiness, not a regression.
  await step("this connector is measurably flaky, worth knowing before trusting a single red run", async () => {
    const attempts = [];
    for (let i = 0; i < 3; i++) {
      const res = await ctx.client.executeQuery(
        { statement: `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}" LIMIT 2` },
        "SIMPLE"
      );
      const empty = res.ok && (!res.body.data || res.body.data.length === 0);
      attempts.push({ status: res.status, empty });
    }
    const bad = attempts.filter((a) => a.status !== 200 || a.empty);
    console.log(
      `OBSERVED: ${attempts.length - bad.length} of ${attempts.length} identical queries returned real data ` +
        `just now${bad.length ? ` - ${bad.length} did not (${JSON.stringify(bad)})` : ""}. Measured live 2026-08-14 ` +
        `across ~15 attempts: mostly correct, one silent empty 200, one outright 400, no pattern found. A single ` +
        `failure in this folder is worth re-running before being treated as a regression.`
    );
  });
}

module.exports = { runGaDiscovery };
