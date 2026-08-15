const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { pollMaterialized } = require("../../helpers/pollMaterialized");
const { load } = require("../../helpers/preflight");

/**
 * Materializing a query over a BI Table.
 *
 * WHAT THIS SCENARIO DELIBERATELY DOES NOT CLAIM, stated first because the
 * omission is the interesting part. This suite has a four-way question open
 * about what materialization actually does:
 *
 *   Stripe       -> snapshot, frozen at the capped 100 forever   (FINDINGS 2)
 *   Postgres     -> snapshot of the whole table                  (PG-D)
 *   Peaka Table  -> NO snapshot, tracks the base live            (FINDINGS 27)
 *   BI Table     -> UNDETERMINABLE
 *
 * The other three were settled by changing the base table and watching whether
 * the materialized result followed. That is impossible here: a BI Table has no
 * write path through the Partner API (FINDINGS 29), so there is no way to make
 * the base drift and therefore no way to tell a real snapshot from a live
 * pass-through that happens to agree with it. Asserting either would be
 * asserting a guess, so this scenario asserts neither.
 *
 * WHAT IT DOES ESTABLISH, measured 2026-08-13 over a BI Table of 8 rows:
 *
 *   createQuery(MATERIALIZED) over peaka.bitable  -> 200
 *   an explicit refresh                            -> a NEW execution timestamp
 *   reading the materialized query                 -> 8 rows, matching the base
 *   filtering THROUGH it (WHERE text = 'txt1')     -> 3, matching the base
 *
 * That last one carries the most weight. BI Table's documented purpose is
 * "high-speed data filtering" over large datasets, and a materialized query is
 * the obvious thing to point a dashboard at - so a filter that gives a
 * different answer through the materialized query than against the table
 * underneath it would be a serious defect, and nothing else in the suite
 * would catch it.
 *
 * THE REFRESH WAIT IS TIMESTAMP-KEYED, via helpers/pollMaterialized.js. A
 * status-only poll is satisfied instantly by the PREVIOUS run's terminal
 * status, which has produced a green-but-meaningless result in this repo twice.
 *
 * GATED on peakaTables.biTableWithData.
 */
async function runBiTableMaterialized(ctx) {
  const report = load();
  const pt = (report && report.peakaTables) || {};
  const biTable = pt.biTable;
  const keyColumn = (pt.biTableColumns || [])[0];

  let queryId = null;
  let queryName = null;
  let baseRows = 0;

  const qualifiedBi = () => `"peaka"."bitable"."${biTable}"`;
  const qualifiedMat = () => `"peaka"."query"."${queryName}"`;

  async function count(fromClause, label) {
    const res = await ctx.client.executeQuery({ statement: `SELECT COUNT(*) AS cnt FROM ${fromClause}` }, "SIMPLE");
    assertStatusIn(res, [200], label);
    return Number(res.body.data[0].cnt);
  }

  await step("the preflight found a BI Table holding rows", async () => {
    assert(biTable, `Preflight recorded no BI Table with rows: ${JSON.stringify(pt)}`);
    assert(keyColumn, `Preflight recorded no user columns on '${biTable}'`);
    baseRows = await count(qualifiedBi(), "COUNT(*) on the BI Table");
    assert(baseRows > 0, "The BI Table reported rows at preflight but returns none now");
    console.log(`  materializing over '${biTable}' (${baseRows} rows)`);
  });

  await step("create a materialized query over the BI Table", async () => {
    const created = await ctx.client.createQuery({
      displayName: `e2e_auto_bi_matview_${ctx.runTag}`,
      inputQuery: `SELECT ${keyColumn} FROM ${qualifiedBi()}`,
      queryType: "MATERIALIZED",
    });
    assertStatusIn(created, [200], "createQuery(MATERIALIZED) over a BI Table");
    assertEqual(String(created.body.queryType).toUpperCase(), "MATERIALIZED", "queryType");
    queryId = created.body.id;
    queryName = created.body.name;
    ctx.createdQueryIds.push(queryId);
    assert(queryName, `Expected a SQL-queryable name: ${JSON.stringify(created.body).slice(0, 200)}`);
  });

  await step("an explicit refresh produces a new execution", async () => {
    const before = await pollMaterialized(ctx.client, queryId, { label: "after create" });
    const priorExecutionStart = before.lastExecutionStartTime;

    const refresh = await ctx.client.refreshMaterializedQuery(queryId);
    assertStatusIn(refresh, [200], "refreshMaterializedQuery");

    // Keyed on the timestamp moving, not on the status - see the helper.
    const after = await pollMaterialized(ctx.client, queryId, {
      label: "after refresh",
      priorExecutionStart,
    });
    assert(
      after.lastExecutionStartTime && after.lastExecutionStartTime !== priorExecutionStart,
      `The refresh did not produce a new execution - lastExecutionStartTime is still ` +
        `${JSON.stringify(priorExecutionStart)}, so the steps below would be reading a result nobody ` +
        `refreshed. Status: ${JSON.stringify(after)}`
    );
  });

  await step("the materialized query returns the same rows as the BI Table", async () => {
    const materialized = await count(qualifiedMat(), "COUNT(*) through the materialized query");
    assertEqual(
      materialized,
      baseRows,
      `rows through the materialized query versus the BI Table itself. Note this does NOT establish ` +
        `whether a snapshot is held - with no write path to the BI Table the base cannot be made to ` +
        `drift, so a real snapshot and a live pass-through are indistinguishable here`
    );
  });

  // THE STEP THAT EARNS ITS KEEP. BI Table exists for filtering; a materialized
  // query is what a dashboard points at. A disagreement between the two would
  // be a serious defect nothing else here would catch.
  await step("a filter through the materialized query agrees with the same filter on the table", async () => {
    const rows = await ctx.client.executeQuery({ statement: `SELECT ${keyColumn} FROM ${qualifiedBi()}` }, "SIMPLE");
    assertStatusIn(rows, [200], "SELECT for a filter value");
    const sample = (rows.body.data.find((r) => r[keyColumn] !== null) || {})[keyColumn];
    assert(sample !== undefined, `Every row has a NULL '${keyColumn}', so there is nothing to filter on`);

    const escaped = String(sample).replace(/'/g, "''");
    const onTable = await count(`${qualifiedBi()} WHERE ${keyColumn} = '${escaped}'`, "filtered count on the BI Table");
    const onMaterialized = await count(
      `${qualifiedMat()} WHERE ${keyColumn} = '${escaped}'`,
      "filtered count through the materialized query"
    );

    assertEqual(
      onMaterialized,
      onTable,
      `rows matching ${keyColumn}='${sample}' through the materialized query versus straight from the BI ` +
        `Table. BI Table's documented purpose is high-speed filtering and a materialized query is what a ` +
        `dashboard reads, so the two disagreeing would silently give a dashboard different numbers from ` +
        `the table it claims to show`
    );
    console.log(`  filter '${sample}': ${onTable} on the table, ${onMaterialized} through the materialized query`);
  });

  await step("delete the materialized query and confirm it is gone", async () => {
    const del = await ctx.client.deleteQuery(queryId);
    assertStatusIn(del, [200, 204], "deleteQuery");
    const idx = ctx.createdQueryIds.indexOf(queryId);
    if (idx !== -1) ctx.createdQueryIds.splice(idx, 1);

    const list = await ctx.client.listQueries();
    assertStatusIn(list, [200], "listQueries");
    assert(
      !(list.body || []).some((q) => String(q.id) === String(queryId)),
      `The materialized query ${queryId} still appears in listQueries() after delete`
    );
  });
}

module.exports = { runBiTableMaterialized };
