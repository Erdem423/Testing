const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");
const { resolveLargeTable } = require("./fixture");

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * MO-C: Export endpoints - the mirror of PG-C, itself the mirror of Stripe's `K`.
 *
 * THE THIRD ROUTE TO THE EXPORT-CAP FINDING. `K` found the live-read cap
 * following data into a downloaded CSV; PG-C showed that was Stripe-specific
 * by exporting Postgres uncapped. Measured live against MongoDB:
 *
 *   Stripe    `charges`  limit 1000 -> rowCount 100    (capped)
 *   Postgres  `e_commerce` limit 1000 -> rowCount 1000  (uncapped)
 *   MongoDB   `commerce` limit  150 -> rowCount  150   (uncapped)
 *
 * A third connector agreeing with Postgres is what turns "not a Postgres
 * quirk" into "not a database-connector quirk" - the export cap really is a
 * symptom of Stripe's own API pagination.
 */
async function runMoExports(ctx) {
  const displayName = `e2e-auto-mo-export-query-${ctx.runTag}`;
  let catalogName = null;
  let table = null;
  let queryId = null;
  let exportId = null;

  async function pollExport(id, label) {
    const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"];
    let last = null;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const res = await ctx.client.getExport(id);
      assertStatus(res, 200, `getExport (${label})`);
      last = res.body;
      if (TERMINAL.includes(String(res.body.status).toUpperCase())) return last;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `Export did not reach a terminal state during '${label}' after ${MAX_POLL_ATTEMPTS} attempts ` +
        `(~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s). Last response: ${JSON.stringify(last)}`
    );
  }

  await step("resolve the catalog and discover a collection to export", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(res.body)}`);
    table = await resolveLargeTable(ctx, catalogName);
    console.log(`exporting from '${table.tableName}' (${table.rowCount} rows)`);
  });

  await step("create a query to export from", async () => {
    const res = await ctx.client.createQuery({
      displayName,
      inputQuery: "SELECT 1 AS one, 'two' AS two",
      queryType: "PLAIN",
    });
    assertStatus(res, 200, "createQuery (for export)");
    assert(res.body && res.body.id, `Expected a query id, got: ${JSON.stringify(res.body)}`);
    queryId = res.body.id;
    ctx.createdQueryIds.push(queryId);
  });

  await step("start a CSV export", async () => {
    const res = await ctx.client.createQueryExport(queryId, { format: "CSV", limit: 100 });
    assertStatusIn(res, [200, 202], "createQueryExport");
    assert(res.body && res.body.id, `Expected an export job id, got: ${JSON.stringify(res.body)}`);
    exportId = res.body.id;
  });

  await step("poll the export until it reaches a terminal state", async () => {
    const last = await pollExport(exportId, "query export");
    assertEqual(String(last.status).toUpperCase(), "SUCCEEDED", "final export status");
    assert(
      typeof last.rowCount === "number",
      `Expected a numeric rowCount on a succeeded export, got: ${JSON.stringify(last)}`
    );
  });

  await step("a succeeded export exposes downloadable files", async () => {
    const res = await ctx.client.getExport(exportId);
    assertStatus(res, 200, "getExport (files)");
    assert(Array.isArray(res.body.files), `Expected a files array, got: ${JSON.stringify(res.body).slice(0, 300)}`);
    assert(res.body.files.length > 0, "Expected at least one downloadable file on a succeeded export");
    const file = res.body.files[0];
    assert(file.url && /^https?:\/\//.test(file.url), `Expected a download URL, got: ${JSON.stringify(file)}`);
  });

  await step("list exports includes this job", async () => {
    const res = await ctx.client.listExports({ limit: 50 });
    assertStatus(res, 200, "listExports");
    assert(Array.isArray(res.body), "Expected an array of export jobs");
    assert(
      res.body.some((e) => e.id === exportId),
      `Export ${exportId} not found in listExports (${res.body.length} returned)`
    );
  });

  await step("exporting a collection directly is NOT capped, unlike Stripe", async () => {
    const cap = ctx.expectedCustomerCountNonCache;
    const requested = Math.min(cap * 10, table.rowCount);
    // Self-skip, not a failure - see the note in mo-a-discovery.js. The whole
    // export lifecycle above (create, start, poll, files, list) exercised
    // fine on this collection; only the uncapped-vs-capped comparison needs
    // more rows than the cap to mean anything.
    if (requested <= cap) {
      note(
        `skipped: collection '${table.tableName}' has only ${table.rowCount} rows - too few to distinguish ` +
          `an uncapped export from a capped one (cap is ${cap}). The export lifecycle steps still ran.`
      );
      return;
    }

    const res = await ctx.client.createTableExport(ctx.catalogId, ctx.schemaName, table.tableName, {
      format: "CSV",
      limit: requested,
    });
    assertStatusIn(res, [200, 202], `createTableExport(${table.tableName})`);
    assert(res.body && res.body.id, `Expected a table-export job id, got: ${JSON.stringify(res.body)}`);

    const last = await pollExport(res.body.id, "table export");
    assertEqual(String(last.status).toUpperCase(), "SUCCEEDED", "table export status");
    assertEqual(
      Number(last.rowCount),
      requested,
      `rows captured by a table export of '${table.tableName}' - expected the full ${requested} requested`
    );
    assert(
      Number(last.rowCount) > cap,
      `A MongoDB table export returned ${last.rowCount} rows, at or below the Stripe cap (${cap}). If a ` +
        `database connector has started truncating exports, the cap is no longer connector-specific.`
    );
    console.log(
      `table export of '${table.tableName}' captured ${last.rowCount} rows - Stripe's equivalent caps at ${cap}`
    );
  });

  await step("cancel is accepted and idempotent", async () => {
    const first = await ctx.client.cancelExport(exportId);
    assertStatusIn(first, [200, 204], "cancelExport");
    const second = await ctx.client.cancelExport(exportId);
    assertStatusIn(second, [200, 204], "cancelExport (repeated - documented as idempotent)");
  });

  await step("delete the export query", async () => {
    const res = await ctx.client.deleteQuery(queryId);
    assertStatus(res, 200, "deleteQuery");
    ctx.createdQueryIds = ctx.createdQueryIds.filter((id) => id !== queryId);
  });
}

module.exports = { runMoExports };
