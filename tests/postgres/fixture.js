const { assertStatus, assert } = require("../../helpers/assert");
const { load } = require("../../helpers/preflight");

/**
 * Works out which table these scenarios should run against, instead of the
 * folder declaring one by name.
 *
 * `e_commerce` and `users` used to be hardcoded in config.js, which meant this
 * folder only ran against one specific database. Resolution order now:
 *
 *   1. PEAKA_PG_TABLE, if set and actually present  - explicit override.
 *   2. Whatever the preflight already measured       - free, no extra queries.
 *   3. A live scan of the schema                     - fallback, so a scenario
 *      run without globalSetup still works rather than depending on it.
 *
 * Step 3 matters: correctness must not hinge on the preflight having run. The
 * preflight is there to decide whether to SKIP, not to supply data the
 * scenarios cannot obtain themselves.
 */

// A schema with hundreds of tables would otherwise turn this into a long scan.
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
  assert(names.length > 0, `Schema '${ctx.schemaName}' has no tables to test against`);

  // 1. Explicit override.
  const hinted = process.env[(ctx.connectorConfig && ctx.connectorConfig.tableEnv) || "PEAKA_PG_TABLE"];
  if (hinted && names.includes(hinted)) {
    return { tableName: hinted, rowCount: await countRows(ctx, catalogName, hinted), source: "PEAKA_PG_TABLE" };
  }

  // 2. Reuse the preflight's measurement if it is still valid for this schema.
  const pf = load();
  const pg = pf && pf.postgres;
  if (pg && pg.schemaName === ctx.schemaName && pg.largestTable && names.includes(pg.largestTable)) {
    return { tableName: pg.largestTable, rowCount: pg.largestTableRowCount, source: "preflight" };
  }

  // 3. Scan.
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
 * Picks a column to use for the filter and aggregate checks, from the live
 * column list rather than from hardcoded names.
 *
 * Returns { numeric, text } - either may be null if the table has no column of
 * that kind, which callers must handle rather than assume.
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
