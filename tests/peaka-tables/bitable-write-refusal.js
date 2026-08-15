const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError } = require("../../helpers/serverError");
const { load } = require("../../helpers/preflight");

/**
 * Every write Peaka's own documentation promises for a BI Table, refused.
 *
 * WHAT THE DOCS CLAIM. peaka.com/connecting-your-data/peaka-bi-table is not
 * vague about this - a BI Table can "execute operations like row-by-row
 * updates, deletions, and insertions" and is "ideal for the storage of event
 * data, particularly excelling when handling bulk data insertion from various
 * sources". Four capabilities, stated plainly.
 *
 * WHAT THE PARTNER API OFFERS: none of them. Measured 2026-08-13 against a BI
 * Table holding 8 real rows:
 *
 *   SqlExec INSERT / UPDATE / DELETE  -> 400 "Statement type 'X' is not allowed"
 *   POST /bitable/{t}/import          -> 404 (no such route)
 *   POST /bitable/{t}/rows|row|data|
 *        records|insert|values        -> 404 (all six)
 *
 * WHY THIS SCENARIO IS NEW RATHER THAN A DUPLICATE. The folder already pins
 * the absence of row-level edits, but only for a PEAKA Table. BI Table could
 * never be tested the same way because nothing could put rows into one, and a
 * refusal to edit an empty table proves very little - "no rows changed" is
 * trivially true when there are no rows. Rows entered through Studio changed
 * that: every attempt below is followed by re-reading the data and proving it
 * is byte-for-byte what it was.
 *
 * THE DISTINCTION THAT MATTERS, and the one worth taking to whoever owns this:
 * the feature is not broken. Studio writes to a BI Table perfectly well - the 8
 * rows here arrived that way. It is the PARTNER API that exposes no write path.
 * So the question is not "is BI Table finished" but "why is its write path
 * UI-only, when the documentation describes it as a capability of the table".
 *
 * GATED on peakaTables.biTableWithData - without real rows this scenario
 * degenerates into the empty-table version that proved nothing.
 */
const REST_SHAPES = ["rows", "row", "data", "records", "insert", "values"];

async function runBiTableWriteRefusal(ctx) {
  const report = load();
  const pt = (report && report.peakaTables) || {};
  const biTable = pt.biTable;
  const keyColumn = (pt.biTableColumns || [])[0];

  const qualified = () => `"peaka"."bitable"."${biTable}"`;
  let before = [];

  async function snapshot(label) {
    const res = await ctx.client.executeQuery({ statement: `SELECT * FROM ${qualified()}` }, "SIMPLE");
    assertStatusIn(res, [200], label);
    // Ordered by _id so two snapshots are comparable regardless of scan order.
    return res.body.data.slice().sort((a, b) => String(a._id).localeCompare(String(b._id)));
  }

  await step("read the BI Table's current contents as a baseline", async () => {
    assert(biTable, `Preflight recorded no BI Table with rows: ${JSON.stringify(pt)}`);
    assert(keyColumn, `Preflight recorded no user columns on '${biTable}'`);
    before = await snapshot("baseline SELECT *");
    assert(before.length > 0, "The BI Table has no rows, so 'nothing changed' would prove nothing");
    console.log(`  baseline: ${before.length} rows in '${biTable}'`);
  });

  await step("SqlExec refuses INSERT UPDATE and DELETE on a BI Table", async () => {
    const statements = {
      INSERT: `INSERT INTO ${qualified()} (${keyColumn}) VALUES ('e2e_should_never_land')`,
      UPDATE: `UPDATE ${qualified()} SET ${keyColumn} = 'e2e_should_never_land'`,
      DELETE: `DELETE FROM ${qualified()}`,
    };

    for (const [kind, statement] of Object.entries(statements)) {
      const res = await ctx.client.executeQuery({ statement }, "SIMPLE");
      assertNoServerError(res, `SqlExec ${kind} on a BI Table`);
      assert(
        res.status >= 400 && res.status < 500,
        `Expected a 4xx rejecting ${kind} on a BI Table, got ${res.status}. The docs describe row-by-row ` +
          `updates, deletions and insertions as BI Table capabilities - if one has started working through ` +
          `SqlExec, that is the gap closing and this scenario should asserted the new behaviour instead. ` +
          `Body: ${JSON.stringify(res.body).slice(0, 200)}`
      );
      const message = String((res.body && res.body.message) || "");
      assert(
        /not allowed/i.test(message),
        `Expected an 'is not allowed' rejection for ${kind}, got: ${message.slice(0, 160)}`
      );
    }
  });

  await step("no import route exists for the bitable path", async () => {
    // The Peaka Table equivalent of this route works and is the only write
    // path that table kind has - see the CSV import scenarios. Its absence
    // here is what leaves BI Table with nothing at all.
    const fd = new FormData();
    fd.append("file", new Blob([`${keyColumn}\ne2e_should_never_land\n`], { type: "text/csv" }), "import.csv");
    fd.append("request", JSON.stringify({ mappings: [{ name: keyColumn, csvColumnName: keyColumn }], containsHeader: true }));

    const res = await ctx.client._request("POST", `/data/projects/${ctx.projectId}/bitable/${biTable}/import`, {
      formData: fd,
    });
    assertNoServerError(res, "POST /bitable/{t}/import");
    assertEqual(res.status, 404, "status for the bitable import route (the Peaka Table equivalent returns 200)");
  });

  await step("no row-level REST endpoint exists under any plausible name", async () => {
    for (const shape of REST_SHAPES) {
      const res = await ctx.client._request("POST", `/data/projects/${ctx.projectId}/bitable/${biTable}/${shape}`, {
        body: { [keyColumn]: "e2e_should_never_land" },
      });
      assertNoServerError(res, `POST /bitable/{t}/${shape}`);
      assertEqual(res.status, 404, `status for POST /bitable/{t}/${shape}`);
    }
    console.log(`  all ${REST_SHAPES.length} REST shapes returned 404`);
  });

  // THE PART THAT WAS IMPOSSIBLE BEFORE. A refusal is only meaningful if
  // nothing slipped through - and with an empty table there was nothing to
  // check. Compare the full contents, not just the count: a write that
  // replaced a value while keeping the row count would otherwise pass.
  await step("the data is byte for byte what it was before every attempt", async () => {
    const after = await snapshot("post-attempt SELECT *");

    assertEqual(after.length, before.length, "row count after every write attempt");
    assert(
      !JSON.stringify(after).includes("e2e_should_never_land"),
      `A value this scenario tried to write is now present in the BI Table. One of the refusals above is ` +
        `not a refusal. Rows: ${JSON.stringify(after).slice(0, 300)}`
    );
    assertEqual(
      JSON.stringify(after),
      JSON.stringify(before),
      `the BI Table's full contents before versus after. Comparing whole rows rather than just the count ` +
        `is deliberate - an UPDATE that changed a value in place would leave the count untouched`
    );
    console.log(`  ${after.length} rows unchanged, including every column value`);
  });
}

module.exports = { runBiTableWriteRefusal };
