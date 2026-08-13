const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { rowsToCsv } = require("../../helpers/csvFixtures");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");

/**
 * Whether the Stripe connector's 100-row cap survives a federated join.
 *
 * WHY THIS IS THE MOST SERIOUS SCENARIO IN THE FOLDER. Peaka's documentation
 * advertises cross-source querying as a headline capability - Peaka Queries
 * let you "combine data from different Peaka Tables and other connected data
 * sources" (docs.peaka.com/connecting-your-data/peaka-query). Meanwhile
 * FINDINGS 1 records that a live Stripe read silently stops at 100 rows, and
 * the API reference documents NO row cap anywhere: execute-query describes
 * `limit` as "Maximum number of rows to return" and promises no ceiling.
 *
 * So the question is whether an UNDOCUMENTED cap contaminates a DOCUMENTED
 * feature. Measured 2026-08-11, it does:
 *
 *   stripe customers, queried directly          -> 100   (the cap; 505 exist)
 *   internal table CROSS JOIN postgres          -> 50000 (2 x 25000, uncapped)
 *   internal table CROSS JOIN stripe customers  -> 100 DISTINCT stripe rows
 *                                                  and 200 join rows (2 x 100)
 *
 * The Postgres leg is the control and it carries real weight: it proves the
 * join mechanism itself is not the limiter. Federation happily produces 50,000
 * rows when neither side is Stripe. Put a Stripe table on one side and the
 * result is computed over 100 of its 505 rows.
 *
 * WHAT A CUSTOMER EXPERIENCES. They join their own customer list against
 * Stripe charges to work out revenue. A number comes back. No error, no
 * warning, no flag - and it is wrong, because four fifths of the Stripe data
 * never entered the join. This is worse than the plain cap in FINDINGS 1: a
 * truncated SELECT at least looks like a truncated SELECT, whereas an
 * aggregate over a truncated join looks like an answer.
 *
 * THIS IS THE SIXTH INDEPENDENT CONFIRMATION that the cap belongs to the
 * Stripe connector (after queries, exports, materialization, saved queries and
 * internal tables) - and the first showing it crosses into federated results.
 *
 * The scenario is GATED on stripe.customers: it is the only one in this folder
 * that needs a second connector, and it must skip rather than fail when Stripe
 * is not configured.
 */
const TABLE_NAME = "e2e_auto_pt_federated";

// The documented cap. Read from .env like the Stripe scenarios do, because it
// is a product constant rather than a property of anyone's data - see the
// EXPECTED_CUSTOMER_COUNT_NON_CACHE row in README's env table.
const CAP = Number(process.env.EXPECTED_CUSTOMER_COUNT_NON_CACHE || 100);

const col = (name) => ({
  name,
  dataType: "VARCHAR",
  displayName: name,
  defaultValue: null,
  isNotNull: false,
  isUnique: false,
});

const TAGS = [{ tag: "a" }, { tag: "b" }];

async function runPtFederatedJoin(ctx) {
  const internal = `"peaka"."table"."${TABLE_NAME}"`;
  let stripeCatalog = null;
  let pgCatalog = null;
  let pgTable = null;

  async function scalar(statement, label) {
    const res = await ctx.client.executeQuery({ statement }, "SIMPLE");
    assertStatusIn(res, [200], label);
    return Number(res.body.data[0].cnt);
  }

  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create and seed a small internal table", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, [col("tag")]);
    assertStatusIn(colRes, [200], "addInternalTableColumns");

    const importRes = await ctx.client.createTableImport(TABLE_NAME, {
      file: rowsToCsv(["tag"], TAGS),
      mappings: [{ name: "tag", csvColumnName: "tag" }],
      containsHeader: true,
    });
    assertStatusIn(importRes, [200], "createTableImport");
    assertEqual(await scalar(`SELECT COUNT(*) AS cnt FROM ${internal}`, "COUNT(*)"), TAGS.length, "seeded rows");

    // This folder's ctx carries no catalog of its own by design
    // (tests/peaka-tables/config.js declares requiredEnv: []), so seed the two
    // fields resolveCatalogName needs rather than widening the folder config
    // for a dependency only this scenario has.
    ctx.catalogId = ctx.catalogId || process.env.PEAKA_CATALOG_ID;
    ctx.catalogNameFromConfig = ctx.catalogNameFromConfig || process.env.PEAKA_CATALOG_NAME;
    await resolveCatalogName(ctx);
    stripeCatalog = ctx.catalogName;
    assert(stripeCatalog, "Could not resolve the Stripe catalog's SQL name");

    const pgRes = await ctx.client.getCatalog(process.env.PEAKA_PG_CATALOG_ID);
    assertStatusIn(pgRes, [200], "getCatalog (Postgres)");
    pgCatalog = pgRes.body.name;

    const tables = await ctx.client.listTables(process.env.PEAKA_PG_CATALOG_ID, process.env.PEAKA_PG_SCHEMA_NAME);
    assertStatusIn(tables, [200], "listTables (Postgres)");
    const names = (tables.body || []).map((t) => t.tableName || t.name).filter(Boolean);
    pgTable = names.includes("e_commerce") ? "e_commerce" : names[0];
    assert(pgTable, "No Postgres table available to join against");
  });

  // THE CONTROL, and it is load-bearing: without it, "joins are capped at 100"
  // and "Stripe is capped at 100" are indistinguishable.
  await step("joining to Postgres returns every row so the join itself is not the limiter", async () => {
    const pgRows = await scalar(
      `SELECT COUNT(*) AS cnt FROM "${pgCatalog}"."${process.env.PEAKA_PG_SCHEMA_NAME}"."${pgTable}"`,
      "COUNT(*) on the Postgres table"
    );
    const joined = await scalar(
      `SELECT COUNT(*) AS cnt FROM ${internal} a CROSS JOIN "${pgCatalog}"."${process.env.PEAKA_PG_SCHEMA_NAME}"."${pgTable}" b`,
      "CROSS JOIN against Postgres"
    );

    assertEqual(joined, TAGS.length * pgRows, "rows from a cross join against Postgres");
    assert(
      joined > CAP,
      `The federated join against Postgres returned ${joined} rows, at or below the Stripe cap (${CAP}). ` +
        `This control exists to prove the join mechanism is not itself capped - if it now is, the next ` +
        `step's result cannot be attributed to the Stripe connector at all.`
    );
    console.log(`  control: internal x postgres -> ${joined} rows, far past the ${CAP} cap`);
  });

  // THE HEADLINE.
  await step("joining to Stripe silently truncates the result at the connector cap", async () => {
    const direct = await scalar(
      `SELECT COUNT(DISTINCT id) AS cnt FROM "${stripeCatalog}"."${process.env.PEAKA_SCHEMA_NAME}"."customers"`,
      "COUNT(DISTINCT id) on Stripe customers, queried directly"
    );
    const throughJoin = await scalar(
      `SELECT COUNT(DISTINCT c.id) AS cnt FROM ${internal} a ` +
        `CROSS JOIN "${stripeCatalog}"."${process.env.PEAKA_SCHEMA_NAME}"."customers" c`,
      "COUNT(DISTINCT stripe id) through a federated join"
    );

    assertEqual(
      direct,
      CAP,
      `distinct Stripe customers visible to a direct live query (FINDINGS 1's cap). If this is no longer ` +
        `${CAP}, the cap itself has changed and this whole scenario needs re-measuring`
    );
    assert(
      throughJoin === CAP,
      `A federated join saw ${throughJoin} distinct Stripe customers, expected the cap (${CAP}). ` +
        `If this is now larger, Peaka has stopped truncating Stripe reads inside joins - a genuine FIX, ` +
        `and this scenario should be rewritten to assert the true row count instead of documenting the gap.`
    );

    const joinRows = await scalar(
      `SELECT COUNT(*) AS cnt FROM ${internal} a ` +
        `CROSS JOIN "${stripeCatalog}"."${process.env.PEAKA_SCHEMA_NAME}"."customers" c`,
      "total rows from the federated join against Stripe"
    );
    assertEqual(
      joinRows,
      TAGS.length * CAP,
      `total federated join rows. The join multiplies by the CAPPED Stripe row count, not the real one - ` +
        `so any aggregate computed over this join is silently wrong, and looks like a valid answer`
    );
    console.log(
      `  FINDING: internal x stripe -> ${throughJoin} distinct Stripe rows and ${joinRows} join rows, ` +
        `both governed by the ${CAP} cap rather than the real table size`
    );
  });

  await step("delete the table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    const idx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const list = await ctx.client.listInternalTables();
    assert(
      !(list.body || []).some((t) => t.tableName === TABLE_NAME),
      `'${TABLE_NAME}' still appears in listInternalTables() after delete`
    );
  });
}

module.exports = { runPtFederatedJoin };
