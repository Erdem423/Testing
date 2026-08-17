const { assertStatusIn, assertStatus, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

/**
 * MO-F: Error handling and pagination - the mirror of PG-F, itself the mirror
 * of Stripe's `F`.
 *
 * A THIRD confirmation that identifier resolution is connector-agnostic - bad
 * table/schema/column names are rejected by name regardless of which backend
 * is behind the catalog.
 *
 * PAGINATION IS THE INTERESTING HALF AGAIN. Stripe's `F` can only ever page
 * within the first ~100 rows, because the cap truncates the scan underneath
 * it. This pages deep into a 25,000-row collection - something Stripe's
 * version structurally cannot do.
 */
async function runMoErrorHandling(ctx) {
  let catalogName = null;
  let table = null;
  let firstColumn = null;

  await step("resolve the catalog and discover a collection", async () => {
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

  await step("querying a non-existent collection returns a clean error", async () => {
    const sql = `SELECT * FROM "${catalogName}"."${ctx.schemaName}"."definitely_not_a_real_collection" LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatusIn(res, [400, 404, 422], "query non-existent collection");
    assert(
      res.body && typeof res.body.message === "string" && res.body.message.includes("definitely_not_a_real_collection"),
      `Expected the error to name the missing collection, got: ${JSON.stringify(res.body)}`
    );
  });

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

  await step("pagination works past the point Stripe's cap would stop at", async () => {
    const cap = ctx.expectedCustomerCountNonCache;
    const pageSize = 20;
    const offsets = [cap + 40, cap + 60];
    // Self-skip, not a failure - see the note in mo-a-discovery.js. This is
    // the only step in this scenario that needs volume; the three
    // error-handling steps above (non-existent collection, schema and column)
    // assert on rejections and need no data whatsoever, so losing them to a
    // row-count gate was the worst case of over-gating in this folder.
    if (table.rowCount <= offsets[1] + pageSize) {
      console.log(
        `skipped: '${table.tableName}' has ${table.rowCount} rows - too few to page past the cap at ` +
          `offset ${offsets[1]}. The error-handling steps still ran.`
      );
      return;
    }

    const pages = [];
    for (const offset of offsets) {
      // OFFSET before LIMIT - Trino's grammar, same as PG-F.
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

module.exports = { runMoErrorHandling };
