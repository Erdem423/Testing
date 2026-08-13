const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");

/**
 * Whether a Peaka Table and a BI Table sharing a name stay independent.
 *
 * THE SPEC ASKS FOR THIS (its CMP-01) and states the expectation plainly:
 * "Iki tablo bagimsiz yasar; veriler birbirine karismaz. Birini silmek
 * digerini etkilemez" - the two live independently, data does not mix, and
 * deleting one does not affect the other.
 *
 * BUT THE SPEC'S OWN VERSION NEVER CREATES THE COLLISION IT TESTS FOR.
 * BI Table strips every underscore from a requested name (FINDINGS 13), so
 * asking for "e2e_auto_cmp_same" twice produces a Peaka Table called
 * "e2e_auto_cmp_same" and a BI Table stored as "e2eautocmpsame" - two
 * different names that could not collide if they tried. This scenario
 * therefore covers BOTH cases, and the second is the real one:
 *
 *   Case A - same REQUESTED name: they diverge, because of the stripping.
 *   Case B - same STORED name: the Peaka Table is deliberately created under
 *            BI Table's already-stripped name, which is the only way to get a
 *            genuine collision.
 *
 * WHY A CUSTOMER REACHES CASE B WITHOUT TRYING. Nobody needs to deliberately
 * name two things alike. Someone creates a BI Table "order_items", Peaka
 * silently stores it as "orderitems", and they separately have a Peaka Table
 * called "orderitems". The platform manufactured a collision the customer
 * never chose and cannot see from the names they typed. If deletion leaked
 * across the two namespaces, removing one would destroy the other - and
 * FINDINGS 20 and 21 mean that loss is unrecoverable.
 *
 * MEASURED 2026-08-11: isolation HOLDS on every axis. The listings do not leak
 * in either direction, each SELECT sees only its own schema and rows, and
 * deleting the Peaka Table leaves the BI Table listed and queryable. So this
 * pins working behaviour - which is the point, because the failure mode it
 * guards against is silent data loss with no error anywhere.
 *
 * IT ALSO DE-RISKS THIS SUITE. helpers/cleanup.js deletes by name from
 * createdInternalTableNames and then createdBiTableNames. Were deletion to
 * leak across namespaces, our own cleanup could destroy resources it never
 * created - so this scenario protects the harness as much as the product.
 *
 * BI Table gets no rows on purpose: the Partner API exposes no write path
 * (FINDINGS 9 plus no import route), so data isolation is asserted in the one
 * direction that can be: the Peaka Table's rows must never surface in the
 * bitable schema.
 */
const REQUESTED_NAME = "e2e_auto_cmp_same_name";
const STRIPPED_NAME = REQUESTED_NAME.split("_").join("");

const col = (name) => ({
  name,
  dataType: "VARCHAR",
  displayName: name,
  defaultValue: null,
  isNotNull: false,
  isUnique: false,
});

const PEAKA_ONLY_VALUE = "ROW_THAT_LIVES_ONLY_IN_THE_PEAKA_TABLE";

// The Peaka Table's column keeps its underscore; the BI Table's deliberately
// has none. BI Table strips underscores from COLUMN names as well as table
// names (FINDINGS 13), so "bt_only" would be stored as "btonly" and every
// SELECT here would fail for a reason that has nothing to do with namespace
// isolation. That quirk has its own scenario; this one stays out of its way.
const PT_COLUMN = "pt_only";
const BT_COLUMN = "btonly";

async function runPtBiNamespace(ctx) {
  let biStoredName = STRIPPED_NAME;

  async function listInternalNames() {
    const res = await ctx.client.listInternalTables();
    assertStatusIn(res, [200], "listInternalTables");
    return (res.body || []).map((t) => t.tableName);
  }

  async function listBiNames() {
    const res = await ctx.client.listBiTables();
    assertStatusIn(res, [200], "listBiTables");
    return (res.body || []).map((t) => t.tableName);
  }

  await step("clean up any leftover tables from a previous run", async () => {
    for (const n of [REQUESTED_NAME, STRIPPED_NAME]) {
      await ctx.client.deleteInternalTable(n).catch(() => {});
      await ctx.client.deleteBiTable(n).catch(() => {});
    }
  });

  await step("the same requested name yields two different stored names", async () => {
    const ptRes = await ctx.client.createInternalTable(REQUESTED_NAME);
    assertStatusIn(ptRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(REQUESTED_NAME);

    const btRes = await ctx.client.createBiTable(REQUESTED_NAME);
    assertStatusIn(btRes, [200], "createBiTable");
    biStoredName = (btRes.body && (btRes.body.tableName || btRes.body.name)) || STRIPPED_NAME;
    ctx.createdBiTableNames.push(biStoredName);

    assertEqual(ptRes.body.tableName, REQUESTED_NAME, "the Peaka Table keeps the requested name");
    assertEqual(
      biStoredName,
      STRIPPED_NAME,
      `the BI Table's stored name. Underscores are stripped (FINDINGS 13), so asking for the same name ` +
        `twice does NOT produce a collision - which is why the spec's own CMP-01 never tests what it ` +
        `intends to, and why the next step builds the collision deliberately`
    );
  });

  await step("neither listing leaks into the other namespace", async () => {
    const internal = await listInternalNames();
    const bi = await listBiNames();

    assert(internal.includes(REQUESTED_NAME), `listInternalTables() is missing '${REQUESTED_NAME}'`);
    assert(bi.includes(biStoredName), `listBiTables() is missing '${biStoredName}'`);
    assert(
      !internal.includes(biStoredName),
      `listInternalTables() returned the BI Table '${biStoredName}'. The two namespaces must stay ` +
        `separate - a leak here would make every "did my table get created" check ambiguous, and would ` +
        `make this suite's own cleanup delete resources it never created`
    );
    assert(
      !bi.includes(REQUESTED_NAME),
      `listBiTables() returned the Peaka Table '${REQUESTED_NAME}' - same leak, opposite direction`
    );
  });

  // THE REAL COLLISION.
  await step("a Peaka Table created under the BI Table's stored name coexists with it", async () => {
    const ptRes = await ctx.client.createInternalTable(biStoredName);
    assertStatusIn(ptRes, [200], "createInternalTable under the BI Table's stored name");
    ctx.createdInternalTableNames.push(biStoredName);

    const internal = await listInternalNames();
    const bi = await listBiNames();
    assert(internal.includes(biStoredName), `the colliding Peaka Table '${biStoredName}' is not listed`);
    assert(
      bi.includes(biStoredName),
      `the BI Table '${biStoredName}' vanished from listBiTables() once a Peaka Table took the same name. ` +
        `Creating one table must never remove another`
    );
  });

  await step("each table keeps its own columns and rows under the shared name", async () => {
    const ptCols = await ctx.client.addInternalTableColumns(biStoredName, [col(PT_COLUMN)]);
    assertStatusIn(ptCols, [200], "addInternalTableColumns on the colliding Peaka Table");
    const btCols = await ctx.client.addBiTableColumns(biStoredName, [col(BT_COLUMN)]);
    assertStatusIn(btCols, [200], "addBiTableColumns on the BI Table");

    const importRes = await ctx.client.createTableImport(biStoredName, {
      file: rowsToCsv([PT_COLUMN], [{ [PT_COLUMN]: PEAKA_ONLY_VALUE }]),
      mappings: [{ name: PT_COLUMN, csvColumnName: PT_COLUMN }],
      containsHeader: true,
    });
    assertStatusIn(importRes, [200], "createTableImport into the colliding Peaka Table");

    const ptSel = await ctx.client.executeQuery(
      { statement: `SELECT ${PT_COLUMN} FROM "peaka"."table"."${biStoredName}"` },
      "SIMPLE"
    );
    assertStatusIn(ptSel, [200], "SELECT from the Peaka Table");
    assertEqual(ptSel.body.data.length, 1, "rows in the Peaka Table");
    assertEqual(ptSel.body.data[0][PT_COLUMN], PEAKA_ONLY_VALUE, "the Peaka Table's own row");

    // The BI Table must not have acquired the Peaka Table's column or its row.
    const btSel = await ctx.client.executeQuery(
      { statement: `SELECT ${BT_COLUMN} FROM "peaka"."bitable"."${biStoredName}"` },
      "SIMPLE"
    );
    assertStatusIn(btSel, [200], "SELECT from the BI Table");
    assertEqual(btSel.body.data.length, 0, "rows in the BI Table (the API cannot seed one, so this one stays empty)");

    const bleed = await ctx.client.executeQuery(
      { statement: `SELECT ${PT_COLUMN} FROM "peaka"."bitable"."${biStoredName}"` },
      "SIMPLE"
    );
    assertStatusIn(
      bleed,
      [400],
      `SELECT of the Peaka Table's column '${PT_COLUMN}' against the bitable schema (it must not resolve there)`
    );
  });

  // THE PROPERTY THAT MATTERS MOST, and the spec calls it out by name.
  await step("deleting the Peaka Table leaves the BI Table listed and queryable", async () => {
    const delRes = await ctx.client.deleteInternalTable(biStoredName);
    assertStatusIn(delRes, [200], "deleteInternalTable on the colliding name");
    const idx = ctx.createdInternalTableNames.indexOf(biStoredName);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const bi = await listBiNames();
    assert(
      bi.includes(biStoredName),
      `Deleting the Peaka Table '${biStoredName}' also removed the BI Table of the same name. That is ` +
        `silent cross-namespace data loss: a customer who never chose the collision (underscore ` +
        `stripping created it) loses a table they did not delete, and FINDINGS 20/21 make it unrecoverable`
    );

    const btSel = await ctx.client.executeQuery(
      { statement: `SELECT ${BT_COLUMN} FROM "peaka"."bitable"."${biStoredName}"` },
      "SIMPLE"
    );
    assertStatusIn(btSel, [200], "SELECT from the BI Table after deleting the Peaka Table of the same name");
  });

  await step("delete both remaining tables and confirm they are gone", async () => {
    const delBi = await ctx.client.deleteBiTable(biStoredName);
    assertStatusIn(delBi, [200], "deleteBiTable");
    const bIdx = ctx.createdBiTableNames.indexOf(biStoredName);
    if (bIdx !== -1) ctx.createdBiTableNames.splice(bIdx, 1);

    const delPt = await ctx.client.deleteInternalTable(REQUESTED_NAME);
    assertStatusIn(delPt, [200], "deleteInternalTable (the original requested name)");
    const pIdx = ctx.createdInternalTableNames.indexOf(REQUESTED_NAME);
    if (pIdx !== -1) ctx.createdInternalTableNames.splice(pIdx, 1);

    const internal = await listInternalNames();
    const bi = await listBiNames();
    assert(!internal.includes(REQUESTED_NAME), `'${REQUESTED_NAME}' still listed after delete`);
    assert(!bi.includes(biStoredName), `BI Table '${biStoredName}' still listed after delete`);
  });
}

module.exports = { runPtBiNamespace };
