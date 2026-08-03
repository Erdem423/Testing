const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 30; // ~90s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Data-export endpoints: create an async export from a saved query, poll it
 * to completion, read it, list exports, and cancel one.
 *
 * Creates its own saved query to export from, and deletes it afterwards.
 *
 * Two shape details that are easy to get wrong, both from the reference:
 *   - createQueryExport returns 202 (Accepted), NOT 200.
 *   - cancelExport returns 204, NOT 200, and is idempotent.
 *
 * NO STEP HERE GUARDS ON "the previous step failed", deliberately. helpers/step.js
 * rethrows, so a scenario aborts at its first failing step and nothing after it
 * runs - a guard for that case can never fire. Four such guards existed until
 * 2026-08-03 and were removed: they encoded a false model of how step() behaves,
 * and had anyone later wrapped step() in a try/catch they would have turned four
 * steps into silent no-ops that still reported green.
 *
 * The way to make a later step safe is to ASSERT the thing it depends on in the
 * step that produces it, which is what the id assertions below do.
 */
async function runExports(ctx) {
  const displayName = `e2e-auto-export-query-${ctx.runTag}`;
  let queryId = null;
  let exportId = null;

  await step("create a query to export from", async () => {
    const res = await ctx.client.createQuery({
      displayName,
      inputQuery: "SELECT 1 AS one, 'two' AS two",
      queryType: "PLAIN",
    });
    assertStatus(res, 200, "createQuery (for export)");
    // Asserted rather than assumed. Without this a 200 carrying no id left
    // queryId undefined, the step still passed, and the rest of the scenario
    // silently skipped itself - the one case the deleted guards actually
    // caught, and one that deserves to fail loudly here instead.
    assert(res.body && res.body.id, `Expected a query id in the createQuery response, got: ${JSON.stringify(res.body)}`);
    queryId = res.body.id;
    ctx.createdQueryIds.push(queryId);
  });

  await step("start a CSV export", async () => {
    const res = await ctx.client.createQueryExport(queryId, { format: "CSV", limit: 100 });
    // 202 is the documented success code here; accept 200 too in case the
    // implementation differs from the reference.
    assertStatusIn(res, [200, 202], "createQueryExport");
    assert(res.body && res.body.id, `Expected an export job id, got: ${JSON.stringify(res.body)}`);
    exportId = res.body.id;
  });

  await step("poll the export until it reaches a terminal state", async () => {
    const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"];
    let reachedTerminal = false;
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
    const res = await ctx.client.listExports({ limit: 50 });
    assertStatus(res, 200, "listExports");
    assert(Array.isArray(res.body), "Expected an array of export jobs");
    assert(
      res.body.some((e) => e.id === exportId),
      `Export ${exportId} not found in listExports (${res.body.length} returned)`
    );
  });

  // Cancelling an already-finished job is documented as idempotent, so this
  // is safe to run against the completed export rather than racing a live one.
  await step("cancel is accepted and idempotent", async () => {
    const first = await ctx.client.cancelExport(exportId);
    assertStatusIn(first, [200, 204], "cancelExport");
    const second = await ctx.client.cancelExport(exportId);
    assertStatusIn(second, [200, 204], "cancelExport (repeated - documented as idempotent)");
  });
}

module.exports = { runExports };
