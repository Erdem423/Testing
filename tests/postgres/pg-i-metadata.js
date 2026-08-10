const { assertStatus, assert, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

const POLL_INTERVAL_MS = 3000;
// ~5 MINUTES, far more than `L`'s ~120s, and the difference is the point.
// Refreshing a Stripe catalog walks 4 tables in one schema. Refreshing a
// Postgres catalog walks the WHOLE database - measured on Supabase: 10 schemas
// including auth/storage/realtime/vault, dozens of tables. A run timed out at
// 120s while legitimately at 86% progress ("schema: auth, table 21 of 23"), so
// the old budget was measuring impatience rather than failure.
const MAX_POLL_ATTEMPTS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Documented statuses are SCREAMING_SNAKE (NOT_ACTIVE, COMPLETED, ...) but the
// API returns lower-kebab ("not-active") - confirmed 2026-07-29 for Stripe and
// again 2026-08-07 for Postgres, so the divergence is platform-wide rather
// than connector-specific. Normalise before comparing.
function normalizeStatus(raw) {
  return String(raw || "").toUpperCase().replace(/-/g, "_");
}

const KNOWN_STATUSES = ["NOT_ACTIVE", "COMPLETED", "WAITING", "ACTIVE", "DELAYED", "FAILED", "PAUSED", "STUCK"];
const TERMINAL_STATUSES = ["NOT_ACTIVE", "COMPLETED", "FAILED", "STUCK"];

/**
 * PG-I: Metadata-refresh endpoints - the mirror of Stripe's `L`.
 *
 * RUNS AGAINST A CATALOG IT CREATES ITSELF, never the shared
 * PEAKA_PG_CATALOG_ID. Refreshing metadata on the shared catalog while PG-A is
 * listing schemas and PG-B is querying it is a genuine interference risk, the
 * same reasoning `L` gives for Stripe.
 *
 * NEEDS NO DATABASE CREDENTIALS: unlike `L`, which creates its own connection,
 * this hangs the throwaway catalog off the EXISTING connection
 * (PEAKA_PG_CONNECTION_ID). Only PG-E needs real credentials.
 *
 * A metadata refresh is where the two connectors might most plausibly differ -
 * Stripe's metadata comes from a paginated remote API, Postgres's from a live
 * JDBC catalog read - so asserting the same status contract holds for both is
 * the point rather than the coverage.
 */
async function runPgMetadata(ctx) {
  const name = `e2e_auto_pg_meta_${ctx.runTag}`.replace(/-/g, "_");
  let catalogId = null;

  await step("create a catalog to refresh", async () => {
    assert(
      ctx.connectionId,
      "Requires PEAKA_PG_CONNECTION_ID in .env - this scenario reuses the existing connection rather than " +
        "creating one, so it needs no database credentials."
    );
    const res = await ctx.client.createCatalog({ name, connectionId: ctx.connectionId });
    assertStatus(res, 200, "createCatalog");
    assert(res.body && res.body.id, "Expected a catalog id in the response");
    catalogId = res.body.id;
    ctx.createdCatalogIds.push(catalogId);
  });

  await step("read the refresh status before triggering anything", async () => {
    const res = await ctx.client.getMetadataRefreshStatus(catalogId);
    assertStatus(res, 200, "getMetadataRefreshStatus (before)");
    assert(res.body && res.body.status !== undefined, `Expected a status field, got: ${JSON.stringify(res.body)}`);
    assertIncludes(KNOWN_STATUSES, normalizeStatus(res.body.status), "metadata refresh status");
  });

  await step("trigger a metadata refresh", async () => {
    const res = await ctx.client.refreshMetadata({ catalogId });
    assertStatus(res, 200, "refreshMetadata");
  });

  await step("refresh status reaches a terminal state", async () => {
    let last = null;
    let terminal = false;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      const res = await ctx.client.getMetadataRefreshStatus(catalogId);
      assertStatus(res, 200, "getMetadataRefreshStatus (polling)");
      last = res.body;
      const status = normalizeStatus(res.body.status);
      assertIncludes(KNOWN_STATUSES, status, "metadata refresh status");
      if (TERMINAL_STATUSES.includes(status)) {
        terminal = true;
        console.log(`metadata refresh settled at '${res.body.status}' after ~${attempt * (POLL_INTERVAL_MS / 1000)}s`);
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    assert(
      terminal,
      `Metadata refresh did not settle after ${MAX_POLL_ATTEMPTS} attempts ` +
        `(~${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s). Last response: ${JSON.stringify(last)}`
    );
    assert(
      normalizeStatus(last.status) !== "FAILED" && normalizeStatus(last.status) !== "STUCK",
      `Metadata refresh ended in a bad state: ${JSON.stringify(last)}`
    );
  });

  // A refresh must not lose the schema - the cheapest possible regression check
  // that it did not leave the catalog broken. Stronger here than in `L`, which
  // only asserts "at least one schema": a Postgres catalog has a known schema
  // that must specifically survive.
  await step("the catalog is still discoverable after refreshing", async () => {
    const res = await ctx.client.listSchemas(catalogId);
    assertStatus(res, 200, "listSchemas after refresh");
    assert(Array.isArray(res.body) && res.body.length > 0, "Expected at least one schema after a metadata refresh");

    const names = res.body.map((s) => s.schemaName);
    assert(
      names.includes(ctx.schemaName),
      `The configured schema '${ctx.schemaName}' vanished after a metadata refresh. Got: ${names.join(", ")}`
    );

    const tables = await ctx.client.listTables(catalogId, ctx.schemaName);
    assertStatus(tables, 200, "listTables after refresh");
    assert(
      Array.isArray(tables.body) && tables.body.length > 0,
      `Expected tables in '${ctx.schemaName}' after a refresh, got: ${JSON.stringify(tables.body).slice(0, 200)}`
    );
    console.log(`after refresh: ${names.length} schemas, ${tables.body.length} tables in '${ctx.schemaName}'`);
  });

  await step("delete the throwaway catalog", async () => {
    const res = await ctx.client.deleteCatalog(catalogId);
    assertStatus(res, 200, "deleteCatalog");
    ctx.createdCatalogIds = ctx.createdCatalogIds.filter((id) => id !== catalogId);
  });
}

module.exports = { runPgMetadata };
