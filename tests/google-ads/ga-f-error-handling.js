const { assertStatusIn, assertStatus, assert, assertEqual } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");
const { resolveLargeTable, withRetry } = require("./fixture");

/**
 * GA-F: Error handling and pagination - the mirror of MO-F/PG-F, itself the
 * mirror of Stripe's `F`.
 *
 * A FOURTH confirmation that identifier resolution is connector-agnostic.
 * Pagination is the interesting half again - Stripe can only ever page
 * within the first ~100 rows; this pages deep into ad_group_criterion's
 * 2,860.
 *
 * COLUMN CHOICE MATTERS HERE, differently from the other three connectors,
 * and needed two corrections before it worked:
 *
 *   1. This table's FIRST declared column is `_q_pagination_anchor`, one of
 *      the synthetic GAQL request-parameter columns (finding 34) - always
 *      NULL. Skipped explicitly.
 *   2. The first REAL column tried, `ad_group_criterion_ad_group` (a foreign
 *      key to the owning ad group), FAILED this scenario outright:
 *      OFFSET/LIMIT pages overlapped completely. Measured why: it has only
 *      29 distinct values across 2,860 rows - `ORDER BY` over a column that
 *      coarse has no stable tiebreaker, so which rows land on which page is
 *      implementation-defined. Not a Peaka bug; a test design mistake caught
 *      by actually running it rather than assuming any non-`_q_` column
 *      would do.
 *
 * The fix follows Google Ads' own convention: every resource type carries a
 * `resource_name` field documented by Google as its stable, globally unique
 * identifier. Confirmed live - `ad_group_criterion_resource_name` is
 * 2,860-of-2,860 distinct - and that is what this scenario orders by.
 */
async function runGaErrorHandling(ctx) {
  let catalogName = null;
  let table = null;
  let orderColumn = null;

  await step("resolve the catalog and discover a table", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    table = await resolveLargeTable(ctx, catalogName);

    const cols = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(cols, 200, `listColumns(${table.tableName})`);
    const candidates = (cols.body || []).filter((c) => !c.name.startsWith("_q_") && !c.name.startsWith("_"));
    assert(candidates.length > 0, `'${table.tableName}' has no non-synthetic column to order by`);
    // Google Ads' own convention: every resource type has a `resource_name`
    // field that is its stable, globally unique identifier - the only kind
    // of column safe to page over without ties. Falls back to the first
    // candidate if this table happens to have no such column.
    const resourceName = candidates.find((c) => c.name.toLowerCase().includes("resource_name"));
    orderColumn = (resourceName || candidates[0]).name;
    console.log(`ordering by '${orderColumn}' (skipping the '_q_*' request-parameter columns)`);
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
    // Self-skips rather than failing. The error-handling steps above assert on
    // rejections and need no rows at all - see tests/postgres/pg-f-error-handling.js.
    if (table.rowCount <= offsets[1] + pageSize) {
      note(
        `skipped: '${table.tableName}' has ${table.rowCount} rows - too few to page past the cap at ` +
          `offset ${offsets[1]}. The error-handling steps still ran.`
      );
      return;
    }

    const pages = [];
    for (const offset of offsets) {
      const sql =
        `SELECT ${orderColumn} FROM "${catalogName}"."${ctx.schemaName}"."${table.tableName}" ` +
        `ORDER BY ${orderColumn} OFFSET ${offset} LIMIT ${pageSize}`;
      const result = await withRetry(async () => {
        const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
        assertStatus(res, 200, `page at offset ${offset}`);
        const empty = !res.body.data || res.body.data.length === 0;
        return { empty, value: res.body.data };
      }, `page at offset ${offset}`);
      assertEqual(result.value.length, pageSize, `rows returned at offset ${offset}`);
      pages.push(result.value.map((r) => String(r[orderColumn])));
    }

    const [page1, page2] = pages;
    const overlap = page1.filter((v) => page2.includes(v));
    assertEqual(overlap.length, 0, `overlapping values between pages at offsets ${offsets.join(" and ")}`);
    console.log(`paged ${pageSize} rows at offsets ${offsets.join(" and ")} - both beyond Stripe's ${cap}-row cap, no overlap`);
  });
}

module.exports = { runGaErrorHandling };
