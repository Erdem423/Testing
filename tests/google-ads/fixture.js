const { assertStatus, assert } = require("../../helpers/assert");
const { load } = require("../../helpers/preflight");

/**
 * Works out which table these scenarios should run against, same shape as
 * tests/postgres/fixture.js and tests/mongodb/fixture.js.
 *
 * ONE REAL DIFFERENCE: retries. Every other connector in this suite answers a
 * query deterministically - Google Ads does not. Measured live 2026-08-14:
 * the exact same `SELECT customer_id, clicks FROM keyword_stats_report LIMIT
 * 2` returned the correct 2 rows on most attempts, an empty array with a
 * clean 200 on some, and an outright 400 on one - no pattern found across
 * column selection, ORDER BY presence, or which table. This is the connector
 * (or the live Google Ads API behind it) being intermittently flaky, the same
 * family of problem FINDINGS already records for exports ("fail
 * intermittently... worth re-running once before being believed") - not a
 * deterministic bug, so nothing here should assert on a single attempt.
 *
 * Resolution order, same as the other two fixtures:
 *   1. PEAKA_GOOGLE_ADS_TABLE, if set and present - explicit override.
 *   2. Whatever the preflight already measured.
 *   3. A live scan - but capped to a short candidate list, not all 150+
 *      tables, both for cost and because most of them are legitimately empty
 *      for an account this size (see tests/google-ads/config.js).
 */
const CANDIDATES = [
  "keyword_stats_report",
  "ad_group_criterion",
  "ad_stats_report",
  "campaign_stats_report",
  "ad_group_stats_report",
  "asset",
];
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` up to RETRY_ATTEMPTS times, accepting the first attempt that
 * looks real - a non-empty result, or an explicit non-2xx status (a genuine
 * rejection is informative; an empty 200 on a table known to hold rows is
 * not). Throws the last attempt's outcome if every retry comes back empty.
 */
async function withRetry(fn, label) {
  let last = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const res = await fn();
    last = res;
    if (res.empty !== true) return res;
    if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  throw new Error(
    `'${label}' returned an empty result on all ${RETRY_ATTEMPTS} attempts. Google Ads is known to be ` +
      `intermittently flaky (see the module comment), but ${RETRY_ATTEMPTS} consecutive empties on a table ` +
      `expected to hold rows is past what that explains.`
  );
}

async function countRows(ctx, catalogName, tableName) {
  const sql = `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${ctx.schemaName}"."${tableName}"`;
  const res = await withRetry(async () => {
    const r = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatus(r, 200, `COUNT(*) on ${tableName}`);
    const empty = !r.body.data || r.body.data.length === 0;
    return { empty, value: empty ? null : Number(r.body.data[0].cnt) };
  }, `COUNT(*) on ${tableName}`);
  return res.value;
}

async function resolveLargeTable(ctx, catalogName) {
  const hinted = process.env[(ctx.connectorConfig && ctx.connectorConfig.tableEnv) || "PEAKA_GOOGLE_ADS_TABLE"];
  const names = hinted ? [hinted] : CANDIDATES;

  let best = null;
  let bestCount = -1;
  for (const name of names) {
    let count;
    try {
      count = await countRows(ctx, catalogName, name);
    } catch (_) {
      continue; // a candidate that never returns real data just isn't the one - try the next
    }
    if (count > bestCount) {
      bestCount = count;
      best = name;
    }
  }
  assert(
    best,
    `None of the candidate tables (${names.join(", ")}) returned usable data. Set PEAKA_GOOGLE_ADS_TABLE ` +
      `to pin one explicitly, or check the account behind PEAKA_PROJECT_ID_ADS actually has data.`
  );
  return { tableName: best, rowCount: bestCount, source: hinted ? "PEAKA_GOOGLE_ADS_TABLE" : "scan" };
}

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

module.exports = { resolveLargeTable, classifyColumns, countRows, withRetry, RETRY_ATTEMPTS, RETRY_DELAY_MS };
