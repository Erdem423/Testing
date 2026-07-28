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

  await step("pagination via limit/offset returns non-overlapping pages", async () => {
    const base = {
      columns: ["id"],
      from: [{ catalogName: ctx.catalogName, schemaName: ctx.schemaName, tableName: "charges" }],
      orderBy: ["id ASC"],
    };

    const page1 = await ctx.client.executeQuery({ ...base, limit: 20, offset: 0 }, "SIMPLE");
    const page2 = await ctx.client.executeQuery({ ...base, limit: 20, offset: 20 }, "SIMPLE");
    assertStatus(page1, 200, "charges page1");
    assertStatus(page2, 200, "charges page2");

    if (page1.body.data.length === 0) {
      console.log("skipped: no charges to paginate - did you run the seed script?");
      return;
    }

    const ids1 = new Set(page1.body.data.map((r) => r.id));
    const ids2 = new Set(page2.body.data.map((r) => r.id));
    const overlap = [...ids1].filter((id) => ids2.has(id));
    assert(overlap.length === 0, `Expected no overlap between pages, found ${overlap.length} duplicate ids`);
  });
}

module.exports = { runErrorHandling };
