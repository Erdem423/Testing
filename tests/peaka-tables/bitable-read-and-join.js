const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");
const { load } = require("../../helpers/preflight");

/**
 * Reading a BI Table that holds real rows, and joining it to a Peaka Table.
 *
 * THIS SCENARIO EXISTS BECAUSE THE WRITE PATH WAS NEVER THE WHOLE STORY. The
 * folder had assumed BI Table was untestable for data because nothing in the
 * Partner API can put rows into one - six endpoint shapes were probed and all
 * 404. That is still true, and it is why the spec's CMP-02 (Peaka Table x BI
 * Table join) was substituted for a Table x Table join.
 *
 * But Peaka's docs describe BI Table as being for "high-speed data filtering"
 * and "rapid data retrieval", and say editing it is "relatively slow" - NOT
 * impossible. Studio can write to one. So the accurate statement is narrower
 * than the folder had it: the PARTNER API exposes no write path, while the
 * product does support writes elsewhere. Rows entered through Studio are fully
 * visible to the API (verified 2026-08-13), which makes every READ path
 * testable after all.
 *
 * TWO TECHNIQUES KEEP THIS HONEST DESPITE NOT OWNING THE DATA.
 *
 * 1. INVARIANTS, NOT VALUES. Nothing here asserts "row 3 says txt1". It
 *    asserts things true of ANY contents - COUNT(*) agreeing with a full
 *    scan, a filter returning a consistent subset, GROUP BY subtotals summing
 *    back to the total. Edit the table in Studio and this still passes, which
 *    is the only way a test over foreign data can be trustworthy.
 *
 * 2. SEED THE SIDE WE CONTROL. The join needs matching keys, and we cannot
 *    write to the BI Table - so the Peaka Table is built FROM the BI Table's
 *    own values, discovered at runtime. The expected join distribution is then
 *    computed from what was actually read rather than hardcoded. That is what
 *    finally closes CMP-02.
 *
 * GATED on peakaTables.biTableWithData: rows can only arrive through Studio, so
 * a project without them has nothing to assert against and must skip. That gate
 * is also the first entry in preflight's peakaTables branch, which previously
 * did not exist at all.
 */
const JOIN_TABLE = "e2e_auto_pt_bijoin";

async function runBiTableRead(ctx) {
  const report = load();
  const pt = (report && report.peakaTables) || {};
  const biTable = pt.biTable;
  const keyColumn = (pt.biTableColumns || [])[0];

  let biRows = [];
  let keyCounts = new Map();

  const qualifiedBi = () => `"peaka"."bitable"."${biTable}"`;

  async function query(statement, label) {
    const res = await ctx.client.executeQuery({ statement }, "SIMPLE");
    assertStatusIn(res, [200], label);
    return res.body.data;
  }

  await step("the preflight found a BI Table holding rows", async () => {
    assert(biTable, `Preflight recorded no BI Table with rows: ${JSON.stringify(pt)}`);
    assert(keyColumn, `Preflight recorded no user columns on '${biTable}'`);
    console.log(`  using BI Table '${biTable}' (${pt.biTableRowCount} rows, columns ${JSON.stringify(pt.biTableColumns)})`);
  });

  await step("a full scan and COUNT star agree on how many rows exist", async () => {
    biRows = await query(`SELECT * FROM ${qualifiedBi()}`, "SELECT * on the BI Table");
    const counted = await query(`SELECT COUNT(*) AS cnt FROM ${qualifiedBi()}`, "COUNT(*) on the BI Table");

    assertEqual(
      Number(counted[0].cnt),
      biRows.length,
      `COUNT(*) versus the number of rows a full scan returns. A disagreement would mean one of the two ` +
        `reads is truncated - which is exactly what the Stripe connector does at 100 rows (FINDINGS 1)`
    );
    assert(biRows.length > 0, "The BI Table reported rows at preflight but returns none now");
  });

  await step("every row carries the system columns a BI Table is documented to add", async () => {
    // _operation is BI Table's ninth system column - the one Peaka Table does
    // not have. Until a populated BI Table existed it had never held a value.
    for (const row of biRows) {
      assert(row._id, `A row has no _id: ${JSON.stringify(row)}`);
      assert(
        row._operation,
        `A row has no _operation: ${JSON.stringify(row)}. It is the column that distinguishes a BI Table ` +
          `from a Peaka Table, so an empty one would make the two indistinguishable in content`
      );
    }
    const operations = [...new Set(biRows.map((r) => r._operation))];
    console.log(`  _operation values present: ${JSON.stringify(operations)}`);
  });

  await step("a projection returns the same rows as a full scan", async () => {
    const projected = await query(`SELECT ${keyColumn} FROM ${qualifiedBi()}`, `SELECT ${keyColumn}`);
    assertEqual(
      projected.length,
      biRows.length,
      `rows from a single-column projection versus SELECT *. Naming columns explicitly must not change ` +
        `how many rows come back`
    );
  });

  await step("a filter returns a subset consistent with the full scan", async () => {
    // Counted client-side from data we already hold, so the expectation is
    // derived rather than assumed - it holds whatever the table contains.
    const nonNull = biRows.filter((r) => r[keyColumn] !== null && r[keyColumn] !== undefined);
    assert(
      nonNull.length > 0,
      `Every row has a NULL '${keyColumn}', so there is nothing to filter on. Add a value in Studio.`
    );

    const sample = nonNull[0][keyColumn];
    const expected = biRows.filter((r) => r[keyColumn] === sample).length;
    const filtered = await query(
      `SELECT ${keyColumn} FROM ${qualifiedBi()} WHERE ${keyColumn} = '${String(sample).replace(/'/g, "''")}'`,
      "filtered SELECT"
    );
    assertEqual(
      filtered.length,
      expected,
      `rows matching ${keyColumn}='${sample}'. The filter must see the whole table, not a truncated scan`
    );
  });

  await step("GROUP BY subtotals sum back to the total row count", async () => {
    const grouped = await query(
      `SELECT ${keyColumn} AS k, COUNT(*) AS cnt FROM ${qualifiedBi()} GROUP BY ${keyColumn}`,
      "GROUP BY on the BI Table"
    );
    const total = grouped.reduce((sum, g) => sum + Number(g.cnt), 0);
    assertEqual(total, biRows.length, "GROUP BY subtotals summed against the full row count");

    keyCounts = new Map(grouped.map((g) => [g.k, Number(g.cnt)]));
    console.log(`  ${grouped.length} distinct '${keyColumn}' values across ${biRows.length} rows`);
  });

  // THE HEADLINE, and the spec scenario that has been blocked since day one.
  await step("a Peaka Table joins to the BI Table on values discovered at runtime", async () => {
    await ctx.client.deleteInternalTable(JOIN_TABLE).catch(() => {});
    const createRes = await ctx.client.createInternalTable(JOIN_TABLE);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(JOIN_TABLE);

    const colRes = await ctx.client.addInternalTableColumns(JOIN_TABLE, [
      { name: "k", dataType: "VARCHAR", displayName: "k", defaultValue: null, isNotNull: false, isUnique: false },
    ]);
    assertStatusIn(colRes, [200], "addInternalTableColumns");

    // Seed from what the BI Table actually holds - one Peaka row per distinct
    // key. A join is then 1:N, and N is knowable from the GROUP BY above.
    const keys = [...keyCounts.keys()].filter((k) => k !== null && k !== undefined);
    assert(keys.length > 0, "No non-null keys to seed the join with");
    const importRes = await ctx.client.createTableImport(JOIN_TABLE, {
      file: rowsToCsv(["k"], keys.map((k) => ({ k: String(k) }))),
      mappings: [{ name: "k", csvColumnName: "k" }],
      containsHeader: true,
    });
    assertStatusIn(importRes, [200], "createTableImport (seeded from BI Table values)");

    const joined = await query(
      `SELECT p.k AS k, COUNT(*) AS cnt ` +
        `FROM "peaka"."table"."${JOIN_TABLE}" p ` +
        `JOIN ${qualifiedBi()} b ON p.k = b.${keyColumn} ` +
        `GROUP BY p.k`,
      "JOIN across a Peaka Table and a BI Table"
    );

    assertEqual(joined.length, keys.length, "distinct keys surviving the join");
    for (const row of joined) {
      assertEqual(
        Number(row.cnt),
        keyCounts.get(row.k),
        `join rows for key '${row.k}' versus the BI Table's own GROUP BY count for it`
      );
    }
    const totalJoined = joined.reduce((s, r) => s + Number(r.cnt), 0);
    assertEqual(
      totalJoined,
      biRows.filter((r) => keys.includes(r[keyColumn])).length,
      "total joined rows against the BI rows whose key was seeded"
    );
    console.log(`  CMP-02 closed: joined ${keys.length} keys, ${totalJoined} rows across the two table kinds`);
  });

  await step("delete the join table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(JOIN_TABLE);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    const idx = ctx.createdInternalTableNames.indexOf(JOIN_TABLE);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const list = await ctx.client.listInternalTables();
    assert(
      !(list.body || []).some((t) => t.tableName === JOIN_TABLE),
      `'${JOIN_TABLE}' still appears in listInternalTables() after delete`
    );
  });
}

module.exports = { runBiTableRead };
