const { assertStatusIn, assertStatus, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");

/**
 * Error Handling & Edge Cases: querying a non-existent table, and pagination
 * correctness. Independent of the other consolidated tests - only needs
 * ctx.catalogName/schemaName from config.
 */
async function runErrorHandling(ctx) {
  await step("resolve catalog name", async () => {
    await resolveCatalogName(ctx);
  });

  await step("querying a non-existent table returns a clean error", async () => {
    const sql = `SELECT * FROM "${ctx.catalogName}"."${ctx.schemaName}"."definitely_not_a_real_table" LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatusIn(res, [400, 404, 422], "query non-existent table");
  });

  // THE OTHER TWO IDENTIFIER POSITIONS. A query names catalog, schema, table
  // and columns; only a bad TABLE was covered, so a connector that resolved
  // any of the rest sloppily would have gone unnoticed.
  //
  // Both assert an EXACT 400 rather than a set. Measured directly before these
  // were written, and pinning them is deliberate: the suite has already had a
  // hedged status set conceal a real bug for as long as the step existed.
  //
  // The message check is the load-bearing half. A 400 alone only says "the
  // query was rejected" - it does not distinguish a genuine resolution failure
  // from a parse error, a quota rejection, or a connector timeout that happens
  // to 400. Requiring the offending identifier to appear by name is what makes
  // this a test of identifier resolution specifically.
  await step("a non-existent schema is rejected by name", async () => {
    const badSchema = "definitely_not_a_schema";
    const sql = `SELECT * FROM "${ctx.catalogName}"."${badSchema}"."customers" LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");

    assertStatus(res, 400, "query with a non-existent schema");
    assert(
      res.body && typeof res.body.message === "string" && res.body.message.includes(badSchema),
      `Expected the error to name the bad schema '${badSchema}', got: ${JSON.stringify(res.body)}`
    );
  });

  await step("a non-existent column is rejected by name", async () => {
    const badColumn = "definitely_not_a_column";
    const sql = `SELECT ${badColumn} FROM "${ctx.catalogName}"."${ctx.schemaName}"."customers" LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");

    assertStatus(res, 400, "query with a non-existent column");
    assert(
      res.body && typeof res.body.message === "string" && res.body.message.includes(badColumn),
      `Expected the error to name the bad column '${badColumn}', got: ${JSON.stringify(res.body)}`
    );
  });

  await step("pagination via limit/offset returns non-overlapping pages", async () => {
    // Paginates 'refunds', NOT 'charges', deliberately.
    //
    // F runs concurrently with C (Data Correctness & Cache Behavior), which
    // creates caches on customers/charges/subscriptions/invoices. Querying a
    // table live while a cache on it is still syncing returns 0 rows -
    // Peaka's query routing prefers an existing cache even before it has
    // data (a confirmed finding, see the README). This step used to use
    // 'charges', which would have collided with C's cache and, worse, done
    // so SILENTLY: the empty-page guard below would have read 0 rows as "no
    // seed data" and skipped, passing while testing nothing.
    //
    // 'refunds' is not cached by any test (85 rows, plenty for two pages of
    // 20). If you ever add a cache on refunds, move this to another
    // uncached table rather than accepting the skip.
    const base = {
      columns: ["id"],
      from: [{ catalogName: ctx.catalogName, schemaName: ctx.schemaName, tableName: "refunds" }],
      orderBy: ["id ASC"],
    };

    const page1 = await ctx.client.executeQuery({ ...base, limit: 20, offset: 0 }, "SIMPLE");
    const page2 = await ctx.client.executeQuery({ ...base, limit: 20, offset: 20 }, "SIMPLE");
    assertStatus(page1, 200, "refunds page1");
    assertStatus(page2, 200, "refunds page2");

    // NO EMPTY-PAGE SKIP HERE ANY MORE, deliberately.
    //
    // This used to `return` when page 1 came back empty, which the reporter
    // counted as a PASSING step - so a catalog with no refunds reported green
    // while verifying nothing. Whether the data exists is now decided ONCE, up
    // front, by the preflight gate on this scenario (see
    // jest/stripe/connector.test.js), which produces a real test.skip that
    // Jest counts separately from a pass.
    //
    // So reaching this point means the preflight saw enough rows, and an empty
    // page here is a genuine failure worth surfacing rather than absorbing.
    assert(
      page1.body.data.length > 0,
      "First page of refunds came back empty even though the preflight measured enough rows. " +
        "That means something changed mid-run (a cache on refunds, or the rows disappearing) - " +
        "not missing seed data."
    );

    const ids1 = new Set(page1.body.data.map((r) => r.id));
    const ids2 = new Set(page2.body.data.map((r) => r.id));
    const overlap = [...ids1].filter((id) => ids2.has(id));
    assert(overlap.length === 0, `Expected no overlap between pages, found ${overlap.length} duplicate ids`);
  });
}

module.exports = { runErrorHandling };
