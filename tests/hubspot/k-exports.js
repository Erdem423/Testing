const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step, note } = require("../../helpers/step");

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 30; // ~90s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Data-export endpoints, HubSpot version of tests/stripe/k-exports.js. This
 * endpoint group exports from a SAVED QUERY, not directly from a connector's
 * tables, so it's connector-agnostic - content is identical to the Stripe
 * version, duplicated per-connector only because of the
 * jest/<connector>/**\/*.test.js testMatch scoping (see README's "Adding
 * another connector").
 */
async function runExports(ctx) {
  const displayName = `e2e-auto-export-query-${ctx.runTag}`;
  let queryId = null;
  let exportId = null;
  let reachedTerminal = false;

  await step("create a query to export from", async () => {
    const res = await ctx.client.createQuery({
      displayName,
      inputQuery: "SELECT 1 AS one, 'two' AS two",
      queryType: "PLAIN",
    });
    assertStatus(res, 200, "createQuery (for export)");
    queryId = res.body.id;
    ctx.createdQueryIds.push(queryId);
  });

  await step("start a CSV export", async () => {
    if (!queryId) {
      note("skipped: no query to export (previous step failed)");
      return;
    }
    const res = await ctx.client.createQueryExport(queryId, { format: "CSV", limit: 100 });
    assertStatusIn(res, [200, 202], "createQueryExport");
    assert(res.body && res.body.id, `Expected an export job id, got: ${JSON.stringify(res.body)}`);
    exportId = res.body.id;
  });

  await step("poll the export until it reaches a terminal state", async () => {
    if (!exportId) {
      note("skipped: no export job was started");
      return;
    }
    const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"];
    let last = null;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const res = await ctx.client.getExport(exportId);
      assertStatus(res, 200, "getExport");
      last = res.body;
      if (TERMINAL.includes(String(res.body.status).toUpperCase())) {
        reachedTerminal = true;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    assert(
      reachedTerminal,
      `Export did not reach a terminal state after ${MAX_POLL_ATTEMPTS} attempts ` +
        `(~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s). Last response: ${JSON.stringify(last)}`
    );
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
    if (!exportId) {
      note("skipped: no export job was started");
      return;
    }
    const res = await ctx.client.listExports({ limit: 50 });
    assertStatus(res, 200, "listExports");
    assert(Array.isArray(res.body), "Expected an array of export jobs");
    assert(
      res.body.some((e) => e.id === exportId),
      `Export ${exportId} not found in listExports (${res.body.length} returned)`
    );
  });

  await step("cancel is accepted and idempotent", async () => {
    if (!exportId) {
      note("skipped: no export job was started");
      return;
    }
    const first = await ctx.client.cancelExport(exportId);
    assertStatusIn(first, [200, 204], "cancelExport");
    const second = await ctx.client.cancelExport(exportId);
    assertStatusIn(second, [200, 204], "cancelExport (repeated - documented as idempotent)");
  });
}

module.exports = { runExports };
