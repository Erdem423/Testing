const { assertStatus, assert } = require("../../helpers/assert");
const { load } = require("../../helpers/preflight");

/**
 * Works out which collection these scenarios should run against, instead of
 * hardcoding one. Identical in shape to tests/postgres/fixture.js - the only
 * differences are the connector id ("mongodb") and the env var read for an
 * explicit pin (PEAKA_MONGO_TABLE).
 *
 * Resolution order:
 *   1. PEAKA_MONGO_TABLE, if set and actually present - explicit override.
 *   2. Whatever the preflight already measured        - free, no extra queries.
 *   3. A live scan of the schema                       - fallback.
 */
const MAX_TABLES_TO_PROBE = 25;

async function countRows(ctx, catalogName, tableName) {
  const sql = `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${ctx.schemaName}"."${tableName}"`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, `COUNT(*) on ${tableName}`);
  return Number(res.body.data[0].cnt);
}

async function resolveLargeTable(ctx, catalogName) {
  const listRes = await ctx.client.listTables(ctx.catalogId, ctx.schemaName);
  assertStatus(listRes, 200, `listTables(${ctx.schemaName})`);
  const names = (listRes.body || []).map((t) => t.tableName).filter(Boolean);
  assert(names.length > 0, `Schema '${ctx.schemaName}' has no collections to test against`);

  const hinted = process.env[(ctx.connectorConfig && ctx.connectorConfig.tableEnv) || "PEAKA_MONGO_TABLE"];
  if (hinted && names.includes(hinted)) {
    return { tableName: hinted, rowCount: await countRows(ctx, catalogName, hinted), source: "PEAKA_MONGO_TABLE" };
  }

  const pf = load();
  const mo = pf && pf.mongodb;
  if (mo && mo.schemaName === ctx.schemaName && mo.largestTable && names.includes(mo.largestTable)) {
    return { tableName: mo.largestTable, rowCount: mo.largestTableRowCount, source: "preflight" };
  }

  let best = null;
  let bestCount = -1;
  for (const name of names.slice(0, MAX_TABLES_TO_PROBE)) {
    const count = await countRows(ctx, catalogName, name);
    if (count > bestCount) {
      bestCount = count;
      best = name;
    }
  }
  return { tableName: best, rowCount: bestCount, source: "scan" };
}

/**
 * Identical to tests/postgres/fixture.js's classifyColumns - the type-string
 * heuristics (int/double/decimal.../char/text) match Trino's declared types
 * regardless of which connector produced them, so nothing here is Mongo- or
 * Postgres-specific.
 */
function classifyColumns(columns) {
  const numeric = [];
  const text = [];
  for (const c of columns) {
    const type = String(c.dataType || "").toLowerCase();
    if (/int|double|decimal|numeric|real|float/.test(type)) numeric.push(c.name);
    else if (/char|text/.test(type)) text.push(c.name);
  }
  return { numeric, text };
}

module.exports = { resolveLargeTable, classifyColumns, countRows };
