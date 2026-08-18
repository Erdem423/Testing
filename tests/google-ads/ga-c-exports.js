const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");
const { resolveLargeTable, withRetry } = require("./fixture");

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GA-C: Export endpoints - the mirror of MO-C/PG-C, itself the mirror of
 * Stripe's `K`.
 *
 * A FIFTH ROUTE TO THE EXPORT-CAP FINDING, after Stripe (capped), Postgres,
 * MongoDB (both uncapped). Measured live against Google Ads:
 *
 *   Stripe    `charges`             limit 1000 -> rowCount 100  (capped)
 *   Postgres  `e_commerce`          limit 1000 -> rowCount 1000 (uncapped)
 *   MongoDB   `commerce`            limit  150 -> rowCount  150 (uncapped)
 *   Google Ads `ad_group_criterion` limit  150 -> rowCount  150 (uncapped)
 *
 * RETRIED, unlike the other three exports scenarios - this connector is
 * measurably flaky under repeated querying (finding 35). A single empty or
 * failed attempt here is that flakiness, not evidence of a real cap.
 */
async function runGaExports(ctx) {
  const displayName = `e2e-auto-ga-export-query-${ctx.runTag}`;
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
      `The export did not reach a terminal state during '${label}' after ${MAX_POLL_ATTEMPTS} attempts. Last: ${JSON.stringify(last)}`
    );
  }

  await step("resolve the catalog and discover a table to export", async () => {
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
    assert(res.body && res.body.id, `Expected an export job id, got: ${JSON.stringify(res.body).slice(0, 200)}`);
    exportId = res.body.id;
  });

  await step("poll the export until it reaches a terminal state", async () => {
    const last = await pollExport(exportId, "query export");
    assertEqual(String(last.status).toUpperCase(), "SUCCEEDED", "final export status");
    assert(typeof last.rowCount === "number", `Expected a numeric rowCount, got: ${JSON.stringify(last)}`);
  });

  await step("a succeeded export exposes downloadable files", async () => {
    const res = await ctx.client.getExport(exportId);
    assertStatus(res, 200, "getExport (files)");
    assert(Array.isArray(res.body.files) && res.body.files.length > 0, `Expected downloadable files, got: ${JSON.stringify(res.body).slice(0, 240)}`);
    assert(res.body.files[0].url && /^https?:\/\//.test(res.body.files[0].url), `Expected a download URL, got: ${JSON.stringify(res.body.files[0])}`);
  });

  await step("list exports includes this job", async () => {
    const res = await ctx.client.listExports({ limit: 50 });
    assertStatus(res, 200, "listExports");
    assert(res.body.some((e) => e.id === exportId), `Export ${exportId} not found in listExports`);
  });

  await step("exporting a table directly is NOT capped, unlike Stripe", async () => {
    const cap = ctx.expectedCustomerCountNonCache;
    const requested = Math.min(cap * 10, table.rowCount);
    // Self-skips rather than failing - the export lifecycle above already
    // exercised fine on this table. See tests/postgres/pg-c-exports.js.
    if (requested <= cap) {
      note(
        `skipped: table '${table.tableName}' has only ${table.rowCount} rows - too few to distinguish ` +
          `uncapped from capped (cap is ${cap}). The export lifecycle steps still ran.`
      );
      return;
    }

    const last = await withRetry(async () => {
      const res = await ctx.client.createTableExport(ctx.catalogId, ctx.schemaName, table.tableName, {
        format: "CSV",
        limit: requested,
      });
      if (res.status !== 200 && res.status !== 202) return { empty: true };
      const polled = await pollExport(res.body.id, "table export");
      const succeeded = String(polled.status).toUpperCase() === "SUCCEEDED";
      return { empty: !succeeded, value: polled };
    }, "table export (uncapped check)");

    assertEqual(String(last.value.status).toUpperCase(), "SUCCEEDED", "table export status");
    assertEqual(Number(last.value.rowCount), requested, `rows captured by the table export`);
    assert(
      Number(last.value.rowCount) > cap,
      `A Google Ads table export returned ${last.value.rowCount} rows, at or below the Stripe cap (${cap}).`
    );
    console.log(`table export of '${table.tableName}' captured ${last.value.rowCount} rows - Stripe's equivalent caps at ${cap}`);
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

module.exports = { runGaExports };
