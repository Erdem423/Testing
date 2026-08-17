const { assertStatusIn, assertStatus, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

/**
 * PG-F: Error handling and pagination - the mirror of Stripe's `F`.
 *
 * IDENTIFIER RESOLUTION is connector-agnostic in principle, so most of this
 * should behave identically to Stripe. Asserting it against a second connector
 * is what turns "Peaka rejects bad identifiers" from an observation about the
 * Stripe connector into a claim about Peaka.
 *
 * PAGINATION IS NOT connector-agnostic, and that is the interesting half.
 * Stripe's `F` pages through `refunds` with limit/offset of 20 - and can only
 * ever page within the first ~100 rows, because the cap truncates the scan
 * underneath it. Here the same technique pages deep into a table of tens of
 * thousands, so this asserts something Stripe's version structurally cannot:
 * that offset keeps working past the point where Stripe would have run out of
 * data.
 */
async function runPgErrorHandling(ctx) {
  let catalogName = null;
  let table = null;
  let firstColumn = null;

  await step("resolve the catalog and discover a table", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(res.body)}`);
    table = await resolveLargeTable(ctx, catalogName);

    const cols = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(cols, 200, `listColumns(${table.tableName})`);
    assert(cols.body && cols.body.length > 0, `Expected columns on '${table.tableName}'`);
    firstColumn = cols.body[0].name;
  });

  await step("querying a non-existent table returns a clean error", async () => {
    const sql = `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."definitely_not_a_real_table" LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatusIn(res, [400, 404, 422], "query non-existent table");
    assert(
      res.body && typeof res.body.message === "string" && res.body.message.includes("definitely_not_a_real_table"),
      `Expected the error to name the missing table, got: ${JSON.stringify(res.body)}`
    );
  });

  // The message check is the load-bearing half, exactly as in Stripe's `F`. A
  // 400 alone only says "rejected" - it cannot distinguish a genuine
  // resolution failure from a parse error or a connector timeout that happens
  // to 400. Requiring the offending identifier by name is what makes this a
  // test of identifier resolution specifically.
  await step("a non-existent schema is rejected by name", async () => {
    const badSchema = "definitely_not_a_schema";
    const sql = `SELECT * FROM "${catalogName}"."${badSchema}"."${table.tableName}" LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");

    assertStatus(res, 400, "query with a non-existent schema");
    assert(
      res.body && typeof res.body.message === "string" && res.body.message.includes(badSchema),
      `Expected the error to name the bad schema '${badSchema}', got: ${JSON.stringify(res.body)}`
    );
  });

  await step("a non-existent column is rejected by name", async () => {
    const badColumn = "definitely_not_a_column";
    const sql = `SELECT ${badColumn} FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}" LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");

    assertStatus(res, 400, "query with a non-existent column");
    assert(
      res.body && typeof res.body.message === "string" && res.body.message.includes(badColumn),
      `Expected the error to name the bad column '${badColumn}', got: ${JSON.stringify(res.body)}`
    );
  });

  // THE HALF STRIPE CANNOT TEST. `F` pages `refunds` at limit/offset 20, always
  // inside the first ~100 rows because the cap truncates the scan. Here the
  // pages sit BEYOND that boundary entirely, so a cap would show up as empty
  // or overlapping pages rather than as plausible-looking data.
  await step("pagination works past the point Stripe's cap would stop at", async () => {
    const cap = ctx.expectedCustomerCountNonCache;
    const pageSize = 20;
    // Deliberately starts beyond the cap: if a Postgres read were capped like
    // Stripe's, both of these pages would come back empty.
    const offsets = [cap + 40, cap + 60];
    // Self-skips rather than failing. This is the only step here that needs
    // volume - the error-handling steps above assert on rejections and need
    // no rows at all, so a row count should never have decided whether they
    // ran.
    if (table.rowCount <= offsets[1] + pageSize) {
      console.log(
        `skipped: '${table.tableName}' has ${table.rowCount} rows - too few to page past the cap at ` +
          `offset ${offsets[1]}. The error-handling steps still ran.`
      );
      return;
    }

    const pages = [];
    for (const offset of offsets) {
      // OFFSET BEFORE LIMIT - Trino's grammar is
      // [ORDER BY ...] [OFFSET n] [LIMIT n], and `LIMIT n OFFSET m` (valid in
      // Postgres and MySQL) is a syntax error here:
      //   "mismatched input 'OFFSET'. Expecting: <EOF>"
      // Stripe's `F` never hits this because it uses the structured query
      // form ({ limit, offset }) rather than raw SQL.
      const sql =
        `SELECT ${firstColumn} FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}" ` +
        `ORDER BY ${firstColumn} OFFSET ${offset} LIMIT ${pageSize}`;
      const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
      assertStatus(res, 200, `page at offset ${offset}`);
      assertEqual(res.body.data.length, pageSize, `rows returned at offset ${offset}`);
      pages.push(res.body.data.map((r) => String(r[firstColumn])));
    }

    const [page1, page2] = pages;
    const overlap = page1.filter((v) => page2.includes(v));
    assertEqual(overlap.length, 0, `overlapping values between pages at offsets ${offsets.join(" and ")}`);
    console.log(
      `paged ${pageSize} rows at offsets ${offsets.join(" and ")} - both beyond Stripe's ${cap}-row cap, no overlap`
    );
  });
}

module.exports = { runPgErrorHandling };
