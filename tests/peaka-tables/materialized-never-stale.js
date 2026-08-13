const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 40; // ~60s
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "CANCELED"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A materialized query over a Peaka Table, and whether its snapshot goes stale.
 *
 * WHAT THE DOCS PROMISE. peaka.com/connecting-your-data/what-is-materialized-query
 * is explicit: a materialized query is "refreshed on a schedule or manually;
 * data can be slightly stale between refreshes". The whole point is trading
 * currency for speed - you get a precomputed snapshot that ages until the next
 * refresh.
 *
 * WHAT ACTUALLY HAPPENS OVER AN INTERNAL TABLE, measured 2026-08-11: there is
 * no snapshot at all. Rows appended to the base table are visible through the
 * materialized query IMMEDIATELY, with no refresh:
 *
 *   create + explicit refresh   -> base 3, materialized 3
 *   append 2 rows, no refresh   -> base 5, materialized 5   <- not stale
 *   refresh again               -> base 5, materialized 5
 *
 * THE FIRST MEASUREMENT OF THIS WAS AMBIGUOUS and worth recording so nobody
 * repeats it. A freshly created MATERIALIZED query reports status COMPLETED
 * with lastExecutionStartTime NULL - "nothing in flight", not "materialized"
 * (the same trap tests/stripe/n-materialized-queries.js documents). Reading it
 * in that state proves nothing, because no execution has ever run. This
 * scenario therefore forces a real materialization FIRST and asserts the
 * timestamps are populated, so the staleness check afterwards is meaningful.
 *
 * THIS IS THE EXACT INVERSE OF FINDINGS 2, and the pair is the interesting
 * part. Over a Stripe table, materialization freezes too HARD - it permanently
 * captures 100 of 505 rows. Over a Peaka Table it does not freeze at all.
 * Same feature, opposite failure, decided by which source sits underneath:
 *
 *   Stripe (uncached API connector) -> snapshot, frozen at the capped 100
 *   Postgres (database)             -> snapshot of the whole table
 *   Peaka Table (internal storage)  -> no snapshot, tracks the base live
 *
 * A plausible explanation is that materialising Peaka's own storage would be
 * pure overhead, so it is a deliberate no-op. That is defensible - but it is
 * undocumented, and it silently breaks the one thing a customer materialises
 * FOR: freezing figures. Someone snapshotting month-end numbers gets a live
 * view whose "snapshot" keeps moving, with the docs telling them the opposite.
 */
const TABLE_NAME = "e2e_auto_pt_matview";
const SEED_ROWS = ["a", "b", "c"];
const APPENDED_ROWS = ["d", "e"];

async function runPtMaterialized(ctx) {
  const baseTable = `"peaka"."table"."${TABLE_NAME}"`;
  let materializedId = null;
  let materializedName = null;

  async function count(fromClause, label) {
    const res = await ctx.client.executeQuery({ statement: `SELECT COUNT(*) AS cnt FROM ${fromClause}` }, "SIMPLE");
    assertStatusIn(res, [200], label);
    return Number(res.body.data[0].cnt);
  }

  function importTags(tags) {
    return ctx.client.createTableImport(TABLE_NAME, {
      file: `tag\n${tags.join("\n")}\n`,
      mappings: [{ name: "tag", csvColumnName: "tag" }],
      containsHeader: true,
    });
  }

  /**
   * Polls until the status is terminal AND, when `priorExecutionStart` is
   * given, until a genuinely NEW execution has begun.
   *
   * KEYING ON THE TIMESTAMP RATHER THAN THE STATUS IS LOAD-BEARING. The status
   * endpoint serves the PREVIOUS terminal value until a new run starts, so a
   * status-only poll is satisfied instantly by a stale reading and the caller
   * believes a refresh ran when it did not. tests/postgres/pg-d-materialized-
   * queries.js had this right first; this scenario originally did not, and
   * paid for it - see the note on the step below.
   */
  async function waitForTerminal(label, priorExecutionStart) {
    let last = null;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const res = await ctx.client.getMaterializedQueryStatus(materializedId);
      assertStatusIn(res, [200], `getMaterializedQueryStatus (${label})`);
      last = res.body;
      const terminal = TERMINAL.includes(String(res.body.status).toUpperCase());
      const moved = priorExecutionStart === undefined || res.body.lastExecutionStartTime !== priorExecutionStart;
      if (terminal && moved) return last;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `Materialized query never reached a terminal state with a new execution during '${label}'. ` +
        `Last: ${JSON.stringify(last)}`
    );
  }

  await step("clean up any leftover table and query from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
    const list = await ctx.client.listQueries().catch(() => ({ body: [] }));
    for (const q of list.body || []) {
      if (String(q.displayName || "").startsWith("e2e_auto_pt_matview")) {
        await ctx.client.deleteQuery(q.id).catch(() => {});
      }
    }
  });

  await step("create the table seed three rows and a materialized query over it", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, [
      { name: "tag", dataType: "VARCHAR", displayName: "tag", defaultValue: null, isNotNull: false, isUnique: false },
    ]);
    assertStatusIn(colRes, [200], "addInternalTableColumns");
    assertStatusIn(await importTags(SEED_ROWS), [200], "createTableImport (seed)");

    const created = await ctx.client.createQuery({
      displayName: `e2e_auto_pt_matview_${ctx.runTag}`,
      inputQuery: `SELECT tag FROM ${baseTable}`,
      queryType: "MATERIALIZED",
    });
    assertStatusIn(created, [200], "createQuery(MATERIALIZED)");
    assertEqual(String(created.body.queryType).toUpperCase(), "MATERIALIZED", "queryType");
    materializedId = created.body.id;
    materializedName = created.body.name;
    ctx.createdQueryIds.push(materializedId);
    assert(materializedName, `Expected a SQL-queryable name: ${JSON.stringify(created.body).slice(0, 200)}`);
  });

  // WITHOUT THIS STEP THE SCENARIO WOULD PROVE NOTHING. A materialized query
  // reporting COMPLETED does not mean it has materialized - that status is
  // also what "nothing in flight" looks like. Force a real execution and prove
  // one ran before measuring anything about staleness.
  //
  // THIS STEP USED TO ASSERT lastExecutionStartTime === null BEFORE THE
  // REFRESH, and that was wrong. Whether Peaka has already kicked off an
  // initial materialization by the time the first poll lands is a RACE: it was
  // null when this scenario was written and a real timestamp on a later run,
  // failing a green test for a reason that had nothing to do with Peaka's
  // behaviour. What actually matters is not that no execution had run, but
  // that OUR refresh produced a NEW one - so capture whatever is there and
  // assert it MOVES.
  await step("an explicit refresh performs a real materialization", async () => {
    const before = await waitForTerminal("after create");
    const priorExecutionStart = before.lastExecutionStartTime;

    const refresh = await ctx.client.refreshMaterializedQuery(materializedId);
    assertStatusIn(refresh, [200], "refreshMaterializedQuery");
    const after = await waitForTerminal("after the first refresh", priorExecutionStart);
    assert(
      after.lastExecutionStartTime && after.lastExecutionStartTime !== priorExecutionStart,
      `The refresh did not produce a new execution - lastExecutionStartTime is still ` +
        `${JSON.stringify(priorExecutionStart)}. Every later step would then be measuring an ` +
        `un-materialized pass-through rather than a real snapshot. Status: ${JSON.stringify(after)}`
    );

    assertEqual(await count(baseTable, "COUNT(*) on the base table"), SEED_ROWS.length, "seeded base rows");
    assertEqual(
      await count(`"peaka"."query"."${materializedName}"`, "COUNT(*) on the materialized query"),
      SEED_ROWS.length,
      "rows visible through the freshly materialized query"
    );
  });

  // THE HEADLINE.
  await step("rows appended after materialization are visible without any refresh", async () => {
    assertStatusIn(await importTags(APPENDED_ROWS), [200], "createTableImport (append)");
    const expected = SEED_ROWS.length + APPENDED_ROWS.length;

    assertEqual(await count(baseTable, "COUNT(*) on the base table after appending"), expected, "base rows after append");

    const materialized = await count(
      `"peaka"."query"."${materializedName}"`,
      "COUNT(*) on the materialized query after appending"
    );
    assert(
      materialized === expected,
      `The materialized query returned ${materialized} rows, expected ${expected} - i.e. it tracked the base ` +
        `table live. If it now returns ${SEED_ROWS.length}, Peaka has started holding a real snapshot for ` +
        `internal tables, which is what its own docs describe ("data can be slightly stale between ` +
        `refreshes"). That would be a FIX bringing behaviour in line with the documentation, and this ` +
        `scenario should be rewritten to assert staleness instead of documenting its absence.`
    );
    console.log(`  FINDING: base ${expected}, materialized ${materialized} - no snapshot, no staleness`);
  });

  await step("a further refresh changes nothing because there was no snapshot to update", async () => {
    // Same timestamp-keyed wait as the first refresh: without a prior value to
    // compare against, this poll would be satisfied by the PREVIOUS run's
    // terminal status and the step would pass without a second refresh ever
    // having happened.
    const before = await ctx.client.getMaterializedQueryStatus(materializedId);
    assertStatusIn(before, [200], "getMaterializedQueryStatus (before the second refresh)");
    const priorExecutionStart = before.body.lastExecutionStartTime;

    const refresh = await ctx.client.refreshMaterializedQuery(materializedId);
    assertStatusIn(refresh, [200], "refreshMaterializedQuery (second)");
    await waitForTerminal("after the second refresh", priorExecutionStart);

    const expected = SEED_ROWS.length + APPENDED_ROWS.length;
    assertEqual(
      await count(`"peaka"."query"."${materializedName}"`, "COUNT(*) after the second refresh"),
      expected,
      "rows after refreshing a materialized query that was already live"
    );
  });

  await step("delete the query and the table and confirm both are gone", async () => {
    const delQuery = await ctx.client.deleteQuery(materializedId);
    assertStatusIn(delQuery, [200, 204], "deleteQuery");
    const qIdx = ctx.createdQueryIds.indexOf(materializedId);
    if (qIdx !== -1) ctx.createdQueryIds.splice(qIdx, 1);

    const delTable = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delTable, [200], "deleteInternalTable");
    const tIdx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (tIdx !== -1) ctx.createdInternalTableNames.splice(tIdx, 1);

    const list = await ctx.client.listInternalTables();
    assert(
      !(list.body || []).some((t) => t.tableName === TABLE_NAME),
      `'${TABLE_NAME}' still appears in listInternalTables() after delete`
    );
  });
}

module.exports = { runPtMaterialized };
