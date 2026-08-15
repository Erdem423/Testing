const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * No row-level UPDATE or DELETE exists anywhere - a capability-gap pin, not
 * the doc's PT-08 scenario as written.
 *
 * The doc expects Peaka Table's headline feature to be "frequent, precise
 * editing" - UPDATE one row, DELETE another, verify the rest untouched.
 * That's not possible through the Partner API as it exists:
 *
 *   - SqlExec is SELECT-only (verified in helpers/peakaClient.js's
 *     executeQuery comment) - UPDATE/DELETE both 400 "Statement type 'X'
 *     is not allowed".
 *   - No row-level REST endpoint exists either - verified 2026-08-06 by
 *     probing PATCH/PUT/DELETE/POST against /table/{t}/rows/{id},
 *     /table/{t}/row/{id}, /table/{t}/data/{id} - all generic 404.
 *
 * So there is no known way to edit or remove a single existing row through
 * this API at all. This scenario pins that as a real, asserted fact rather
 * than silently omitting it: if Peaka ever ships a row-edit path, one of
 * these steps starts returning something other than a clean rejection, and
 * the test goes red to say so.
 */
const TABLE_NAME = "e2e_auto_pt_no_row_edit";

async function runPtNoRowEdit(ctx) {
  await step("clean up any leftover table from a previous run", async () => {
    await ctx.client.deleteInternalTable(TABLE_NAME).catch(() => {});
  });

  await step("create the table and import 2 known rows", async () => {
    const createRes = await ctx.client.createInternalTable(TABLE_NAME);
    assertStatusIn(createRes, [200], "createInternalTable");
    ctx.createdInternalTableNames.push(TABLE_NAME);

    const colRes = await ctx.client.addInternalTableColumns(TABLE_NAME, [
      { name: "id", dataType: "BIGINT", displayName: "id", isNotNull: false, isUnique: false },
      { name: "label", dataType: "VARCHAR", displayName: "label", isNotNull: false, isUnique: false },
    ]);
    assertStatusIn(colRes, [200], "addInternalTableColumns");

    const importRes = await ctx.client.createTableImport(TABLE_NAME, {
      file: "id,label\n1,original-one\n2,original-two\n",
      mappings: [{ name: "id", csvColumnName: "id" }, { name: "label", csvColumnName: "label" }],
      containsHeader: true,
    });
    assertStatusIn(importRes, [200], "createTableImport");
  });

  await step("SqlExec UPDATE is rejected, and the row is genuinely untouched", async () => {
    const res = await ctx.client.executeQuery(
      { statement: `UPDATE "peaka"."table"."${TABLE_NAME}" SET label = 'edited' WHERE id = 1` },
      "SIMPLE"
    );
    assertEqual(res.status, 400, "UPDATE via SqlExec");
    assert(
      /not allowed/i.test((res.body && res.body.message) || ""),
      `Expected an 'is not allowed' message, got: ${JSON.stringify(res.body)}`
    );

    // Not just "the API said no" - confirm the row is REALLY unchanged, the
    // way the bad-mapping scenario caught a case that said no on paper but
    // wrote data anyway.
    const sel = await ctx.client.executeQuery(
      { statement: `SELECT label FROM "peaka"."table"."${TABLE_NAME}" WHERE id = 1` },
      "SIMPLE"
    );
    assertStatusIn(sel, [200], "SELECT after the rejected UPDATE");
    assertEqual(sel.body.data[0].label, "original-one", "row 1's label after a rejected UPDATE");
  });

  await step("SqlExec DELETE is rejected, and the row count is genuinely unchanged", async () => {
    const res = await ctx.client.executeQuery(
      { statement: `DELETE FROM "peaka"."table"."${TABLE_NAME}" WHERE id = 2` },
      "SIMPLE"
    );
    assertEqual(res.status, 400, "DELETE via SqlExec");
    assert(
      /not allowed/i.test((res.body && res.body.message) || ""),
      `Expected an 'is not allowed' message, got: ${JSON.stringify(res.body)}`
    );

    const sel = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."table"."${TABLE_NAME}"` },
      "SIMPLE"
    );
    assertStatusIn(sel, [200], "COUNT(*) after the rejected DELETE");
    assertEqual(Number(sel.body.data[0].cnt), 2, "row count after a rejected DELETE");
  });

  await step("no alternate row-level REST endpoint exists either", async () => {
    const sel = await ctx.client.executeQuery(
      { statement: `SELECT _id FROM "peaka"."table"."${TABLE_NAME}" WHERE id = 1` },
      "SIMPLE"
    );
    const rowId = sel.body.data[0]._id;

    for (const [method, suffix] of [
      ["PATCH", "rows"],
      ["PUT", "rows"],
      ["DELETE", "rows"],
      ["PATCH", "row"],
    ]) {
      const res = await ctx.client._request(
        method,
        `/data/projects/${ctx.projectId}/table/${TABLE_NAME}/${suffix}/${rowId}`,
        method === "DELETE" ? undefined : { body: { label: "edited" } }
      );
      assertEqual(res.status, 404, `${method} .../${suffix}/{rowId} - expected no such route`);
    }
  });

  await step("delete the table and confirm it is gone", async () => {
    const delRes = await ctx.client.deleteInternalTable(TABLE_NAME);
    assertStatusIn(delRes, [200], "deleteInternalTable");
    const idx = ctx.createdInternalTableNames.indexOf(TABLE_NAME);
    if (idx !== -1) ctx.createdInternalTableNames.splice(idx, 1);

    const list = await ctx.client.listInternalTables();
    const stillPresent = (list.body || []).some((t) => t.tableName === TABLE_NAME);
    assert(!stillPresent, `'${TABLE_NAME}' still appears in listInternalTables() after delete`);
  });
}

module.exports = { runPtNoRowEdit };
