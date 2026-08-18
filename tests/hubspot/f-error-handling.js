const { assertStatusIn, assertStatus, assert } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");

/**
 * Error Handling & Edge Cases, HubSpot version of tests/stripe/f-error-handling.js.
 * Independent of the other consolidated tests - only needs
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

  await step("pagination via limit/offset returns non-overlapping pages", async () => {
    // Paginates 'line_items', NOT 'contacts'/'companies'/'deals', deliberately -
    // this scenario runs concurrently with C (Data Correctness & Cache
    // Behavior), which caches contacts/companies/deals. Querying a table live
    // while a cache on it is still syncing is a confirmed Peaka bug on
    // Stripe (returns 0 rows instead of real data - see FINDINGS.md), and
    // there is no reason to assume HubSpot's connector is immune. 'line_items'
    // is not cached by any HubSpot scenario in this suite; if that ever
    // changes, move this to another uncached table rather than accepting a
    // silent skip.
    const base = {
      columns: ["id"],
      from: [{ catalogName: ctx.catalogName, schemaName: ctx.schemaName, tableName: "line_items" }],
      orderBy: ["id ASC"],
    };

    const page1 = await ctx.client.executeQuery({ ...base, limit: 20, offset: 0 }, "SIMPLE");
    const page2 = await ctx.client.executeQuery({ ...base, limit: 20, offset: 20 }, "SIMPLE");
    assertStatus(page1, 200, "line_items page1");
    assertStatus(page2, 200, "line_items page2");

    if (page1.body.data.length === 0) {
      note("skipped: no line_items to paginate - is the HubSpot sandbox seeded?");
      return;
    }

    const ids1 = new Set(page1.body.data.map((r) => r.id));
    const ids2 = new Set(page2.body.data.map((r) => r.id));
    const overlap = [...ids1].filter((id) => ids2.has(id));
    assert(overlap.length === 0, `Expected no overlap between pages, found ${overlap.length} duplicate ids`);
  });
}

module.exports = { runErrorHandling };
