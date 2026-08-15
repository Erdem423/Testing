const { assertStatus, assert, assertIncludes } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

const POLL_INTERVAL_MS = 3000;
// MongoDB's connect2 connection has only 2 collections across 2 databases -
// a much smaller catalog than Postgres's Supabase instance (10 schemas), so a
// refresh should settle far faster. Kept generous anyway rather than tuned
// tight, since a slow refresh is a Peaka-side timing question this suite
// should observe rather than assume away.
const MAX_POLL_ATTEMPTS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same platform-wide divergence PG-I documents: documented statuses are
// SCREAMING_SNAKE, the API returns lower-kebab. Confirmed for a third
// connector here.
function normalizeStatus(raw) {
  return String(raw || "").toUpperCase().replace(/-/g, "_");
}

const KNOWN_STATUSES = ["NOT_ACTIVE", "COMPLETED", "WAITING", "ACTIVE", "DELAYED", "FAILED", "PAUSED", "STUCK"];
const TERMINAL_STATUSES = ["NOT_ACTIVE", "COMPLETED", "FAILED", "STUCK"];

/**
 * MO-I: Metadata-refresh endpoints - the mirror of PG-I, itself the mirror of
 * Stripe's `L`.
 *
 * RUNS AGAINST A CATALOG IT CREATES ITSELF, same reasoning as PG-I: refreshing
 * metadata on the shared PEAKA_MONGO_CATALOG_ID while MO-A is listing schemas
 * or MO-B is querying it is a genuine interference risk.
 *
 * NEEDS NO DATABASE CREDENTIALS: hangs the throwaway catalog off the EXISTING
 * connection (PEAKA_MONGO_CONNECTION_ID), same as MO-G.
 *
 * A metadata refresh is where a document store and a relational database
 * might most plausibly differ - Postgres reads a live JDBC catalog, MongoDB's
 * schema is INFERRED by sampling documents rather than declared anywhere - so
 * asserting the same status contract holds for a third connector is the
 * point rather than the coverage.
 */
async function runMoMetadata(ctx) {
  const name = `e2e_auto_mo_meta_${ctx.runTag}`.replace(/-/g, "_");
  let catalogId = null;

  await step("create a catalog to refresh", async () => {
    assert(
      ctx.connectionId,
      "Requires PEAKA_MONGO_CONNECTION_ID in .env - this scenario reuses the existing connection rather than " +
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
      `Expected collections in '${ctx.schemaName}' after a refresh, got: ${JSON.stringify(tables.body).slice(0, 200)}`
    );
    console.log(`after refresh: ${names.length} schemas, ${tables.body.length} collection(s) in '${ctx.schemaName}'`);
  });

  await step("delete the throwaway catalog", async () => {
    const res = await ctx.client.deleteCatalog(catalogId);
    assertStatus(res, 200, "deleteCatalog");
    ctx.createdCatalogIds = ctx.createdCatalogIds.filter((id) => id !== catalogId);
  });
}

module.exports = { runMoMetadata };
