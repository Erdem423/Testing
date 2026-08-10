const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * CMP: join across two Peaka Tables - adapted from the doc's CMP-02, which
 * literally wants Peaka Table x Peaka BI Table.
 *
 * That version is blocked: BI Table has no known write path at all (no
 * import/sample routes, no row-level endpoint - see helpers/peakaClient.js's
 * createBiTable comment), so there is no way to populate one with real data
 * to join against. This proves the same underlying claim - internal tables
 * can be joined and aggregated via SqlExec - using two Peaka Tables instead,
 * both seeded through the one write path that actually exists (CSV import).
 * Revisit as CMP-02 proper once a BI Table write path is found.
 */
const USERS_TABLE = "e2e_auto_cmp_join_users";
const EVENTS_TABLE = "e2e_auto_cmp_join_events";

// Known distribution per user - 5/3/2 events, matching the doc's own
// CMP-02 example - so the join's GROUP BY has an exact expected answer.
const USERS = [
  { user_id: "1", name: "alice" },
  { user_id: "2", name: "bob" },
  { user_id: "3", name: "carol" },
];
const EVENT_COUNTS = { 1: 5, 2: 3, 3: 2 };

async function runCmpInternalJoin(ctx) {
  await step("clean up any leftover tables from a previous run", async () => {
    await ctx.client.deleteInternalTable(USERS_TABLE).catch(() => {});
    await ctx.client.deleteInternalTable(EVENTS_TABLE).catch(() => {});
  });

  await step("create and seed the users table", async () => {
    const createRes = await ctx.client.createInternalTable(USERS_TABLE);
    assertStatusIn(createRes, [200], "createInternalTable (users)");
    ctx.createdInternalTableNames.push(USERS_TABLE);

    const colRes = await ctx.client.addInternalTableColumns(USERS_TABLE, [
      { name: "user_id", dataType: "BIGINT", displayName: "user_id", isNotNull: false, isUnique: false },
      { name: "name", dataType: "VARCHAR", displayName: "name", isNotNull: false, isUnique: false },
    ]);
    assertStatusIn(colRes, [200], "addInternalTableColumns (users)");

    const csv = "user_id,name\n" + USERS.map((u) => `${u.user_id},${u.name}`).join("\n") + "\n";
    const importRes = await ctx.client.createTableImport(USERS_TABLE, {
      file: csv,
      mappings: [{ name: "user_id", csvColumnName: "user_id" }, { name: "name", csvColumnName: "name" }],
      containsHeader: true,
    });
    assertStatusIn(importRes, [200], "createTableImport (users)");
    assertEqual(importRes.body.result.processed, USERS.length, "users rows processed");
  });

  await step("create and seed the events table with a known per-user distribution", async () => {
    const createRes = await ctx.client.createInternalTable(EVENTS_TABLE);
    assertStatusIn(createRes, [200], "createInternalTable (events)");
    ctx.createdInternalTableNames.push(EVENTS_TABLE);

    const colRes = await ctx.client.addInternalTableColumns(EVENTS_TABLE, [
      { name: "user_id", dataType: "BIGINT", displayName: "user_id", isNotNull: false, isUnique: false },
      { name: "event_type", dataType: "VARCHAR", displayName: "event_type", isNotNull: false, isUnique: false },
    ]);
    assertStatusIn(colRes, [200], "addInternalTableColumns (events)");

    const rows = [];
    for (const [userId, count] of Object.entries(EVENT_COUNTS)) {
      for (let i = 0; i < count; i++) rows.push(`${userId},click`);
    }
    const csv = "user_id,event_type\n" + rows.join("\n") + "\n";
    const importRes = await ctx.client.createTableImport(EVENTS_TABLE, {
      file: csv,
      mappings: [{ name: "user_id", csvColumnName: "user_id" }, { name: "event_type", csvColumnName: "event_type" }],
      containsHeader: true,
    });
    assertStatusIn(importRes, [200], "createTableImport (events)");
    assertEqual(importRes.body.result.processed, rows.length, "events rows processed");
  });

  await step("JOIN + GROUP BY across the two tables matches the known distribution", async () => {
    const res = await ctx.client.executeQuery(
      {
        statement:
          `SELECT u.name, COUNT(*) AS cnt FROM "peaka"."table"."${USERS_TABLE}" u ` +
          `JOIN "peaka"."table"."${EVENTS_TABLE}" e ON u.user_id = e.user_id ` +
          `GROUP BY u.name ORDER BY u.name`,
      },
      "SIMPLE"
    );
    assertStatusIn(res, [200], "JOIN + GROUP BY");

    const byName = {};
    for (const row of res.body.data) byName[row.name] = Number(row.cnt);

    for (const user of USERS) {
      const expected = EVENT_COUNTS[user.user_id];
      assertEqual(byName[user.name], expected, `event count for '${user.name}'`);
    }
  });

  await step("delete both tables and confirm they are gone", async () => {
    for (const tableName of [USERS_TABLE, EVENTS_TABLE]) {
      const delRes = await ctx.client.deleteInternalTable(tableName);
      assertStatusIn(delRes, [200], `deleteInternalTable (${tableName})`);
      const idx = ctx.createdInternalTableNames.indexOf(tableName);
      if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);
    }

    const list = await ctx.client.listInternalTables();
    const names = (list.body || []).map((t) => t.tableName);
    assert(!names.includes(USERS_TABLE), `'${USERS_TABLE}' still appears in listInternalTables()`);
    assert(!names.includes(EVENTS_TABLE), `'${EVENTS_TABLE}' still appears in listInternalTables()`);
  });
}

module.exports = { runCmpInternalJoin };
