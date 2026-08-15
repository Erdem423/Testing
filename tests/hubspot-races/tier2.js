const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { duringSync, duringExport, simultaneously, sleep } = require("../../helpers/raceWindow");

// UNVERIFIED PLACEHOLDER - a well-formed but wrong HubSpot credential. The
// real shape (OAuth vs. bearer token) is unconfirmed - see
// tests/hubspot/g-connections.js's header comment. If HubSpot connections in
// Peaka are OAuth-based, this string won't even parse as a credential and
// the "updateConnection to a bad token" step below will need reshaping once
// that's known.
const BAD_TOKEN = "deliberately_invalid_for_race_testing";

/**
 * Tier 2 concurrency conflicts, HubSpot version of tests/races/tier2.js -
 * cross-resource races that test dependency ordering.
 *
 * SAFETY: every scenario here creates its OWN connection and catalog and
 * deletes only those - nothing touches PEAKA_HUBSPOT_CATALOG_ID.
 *
 * Scenario 4 (deleteCatalog mid-sync) is gated behind RUN_RISKY_RACES=true,
 * same as Stripe's version, for the same reason: it can strand a cache no
 * endpoint enumerates.
 *
 * UNLIKE the Stripe version, this does not assume any specific outcome is a
 * "confirmed finding" - Stripe's tier2 was written after observing real
 * results (e.g. the credential-caching question in scenario 05). This file
 * has not been run against real HubSpot data, so every outcome is logged as
 * a first observation.
 */
async function runTier2Races(ctx) {
  async function throwawayCatalog(label) {
    const name = `e2e-auto-race-${label}-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "hubspot",
      credential: { accessToken: ctx.token },
    });
    assertStatus(conn, 200, `createConnection(${label})`);
    ctx.createdConnectionIds.push(conn.body.id);

    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, `createCatalog(${label})`);
    ctx.createdCatalogIds.push(cat.body.id);

    const read = await ctx.client.getCatalog(cat.body.id);
    assertStatus(read, 200, `getCatalog(${label})`);
    return { connectionId: conn.body.id, catalogId: cat.body.id, catalogName: read.body.name };
  }

  function untrack(arr, value) {
    const i = arr.indexOf(value);
    if (i !== -1) arr.splice(i, 1);
  }

  await step("deleteConnection racing an in-flight query", async () => {
    const { connectionId, catalogId, catalogName } = await throwawayCatalog("conn-del");
    const sql = `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${ctx.schemaName}"."contacts"`;

    const baseline = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    console.log(`  baseline query before the race -> ${baseline.status}`);
    if (baseline.status !== 200) {
      console.log(
        `  inconclusive: the throwaway catalog isn't queryable yet (${baseline.status}), so nothing can be ` +
          `concluded from racing a delete against it. Reporting invariants only.`
      );
    }

    const [query, del] = await simultaneously([
      () => ctx.client.executeQuery({ statement: sql }, "SIMPLE"),
      () => ctx.client.deleteConnection(connectionId),
    ]);

    for (const [label, o] of [["query", query], ["deleteConnection", del]]) {
      if (!o.ok) {
        console.log(`  ${label} threw: ${o.error && o.error.message}`);
        continue;
      }
      console.log(`  ${label} -> ${o.value.status}`);
      assert(o.value.status < 500, `${label} returned ${o.value.status} when raced - a server error`);
    }
    if (del.ok && del.value.status === 200) untrack(ctx.createdConnectionIds, connectionId);

    await sleep(2000);
    const after = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    console.log(`  post-race query -> ${after.status}`);
    assert(
      after.status < 500,
      `Querying through a catalog whose connection was deleted returned ${after.status} - must be a clean 4xx.`
    );
    if (baseline.status === 200) {
      assert(
        after.status !== 200,
        `The catalog was queryable before its connection was deleted and still returns 200 afterwards.`
      );
      console.log("  confirmed: queryable before the delete, cleanly failing after it");
    }

    const delCat = await ctx.client.deleteCatalog(catalogId);
    assertStatusIn(delCat, [200, 400, 404], "deleteCatalog after its connection was removed");
    if (delCat.status === 200) untrack(ctx.createdCatalogIds, catalogId);
  });

  await step("deleteQuery racing its own running export", async () => {
    const created = await ctx.client.createQuery({
      displayName: `e2e-auto-race-export-${ctx.runTag}`,
      inputQuery: `SELECT id FROM "${ctx.catalogNameFromConfig || "hubspot"}"."${ctx.schemaName}"."contacts"`,
      queryType: "PLAIN",
    });
    assertStatus(created, 200, "createQuery (for export race)");
    const queryId = created.body.id;
    ctx.createdQueryIds.push(queryId);

    const exp = await ctx.client.createQueryExport(queryId, { format: "CSV", limit: 1000 });
    assertStatusIn(exp, [200, 202], "createQueryExport");
    const exportId = exp.body.id;

    const outcome = await duringExport(ctx, exportId, () => ctx.client.deleteQuery(queryId));
    console.log(
      `  deleteQuery mid-export -> ${outcome.result.status} (entered window: ${outcome.enteredWindow}, ` +
        `export status at fire: ${outcome.statusAtFire})`
    );
    assert(outcome.result.status < 500, `deleteQuery mid-export returned ${outcome.result.status} - a server error`);
    if (outcome.result.status === 200) untrack(ctx.createdQueryIds, queryId);

    const EXPORT_TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "CANCELED", "EXPIRED"];
    let finalStatus = null;
    for (let attempt = 1; attempt <= 30; attempt++) {
      const res = await ctx.client.getExport(exportId);
      assert(res.status < 500, `getExport returned ${res.status} after its query was deleted - a server error`);
      if (res.status !== 200) {
        finalStatus = `HTTP_${res.status}`;
        break;
      }
      finalStatus = String(res.body.status).toUpperCase();
      if (EXPORT_TERMINAL.includes(finalStatus)) break;
      await sleep(2000);
    }
    console.log(`  export settled at ${finalStatus}`);
    assert(
      finalStatus && (EXPORT_TERMINAL.includes(finalStatus) || finalStatus.startsWith("HTTP_")),
      `Export never reached a terminal state after its query was deleted (last: ${finalStatus})`
    );
  });

  await step("updateConnection to a bad token racing a query", async () => {
    const { connectionId, catalogId, catalogName } = await throwawayCatalog("cred-swap");
    const sql = `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${ctx.schemaName}"."contacts"`;

    const baseline = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    console.log(`  baseline query with a good token -> ${baseline.status}`);

    const [query, update] = await simultaneously([
      () => ctx.client.executeQuery({ statement: sql }, "SIMPLE"),
      () =>
        ctx.client.updateConnection(connectionId, {
          name: `e2e-auto-race-cred-swap-${ctx.runTag}`,
          type: "hubspot",
          credential: { accessToken: BAD_TOKEN },
        }),
    ]);

    for (const [label, o] of [["query", query], ["updateConnection", update]]) {
      if (!o.ok) {
        console.log(`  ${label} threw: ${o.error && o.error.message}`);
        continue;
      }
      console.log(`  ${label} -> ${o.value.status}`);
      assert(o.value.status < 500, `${label} returned ${o.value.status} when raced - a server error`);
    }

    const swapSucceeded = update.ok && update.value.status === 200;

    if (!swapSucceeded) {
      const status = update.ok ? update.value.status : "threw";
      console.log(
        `  updateConnection was rejected (${status}) - the "is the old credential cached?" question cannot ` +
          `be probed this way; it needs a token that's well-formed AND accepted at update time but ` +
          `unauthorised at query time, not an obviously fake one.`
      );
      await sleep(1000);
      const after = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
      console.log(`  post-race query -> ${after.status} (expected to still work: the token never changed)`);
      assert(after.status < 500, `Post-race query returned ${after.status} - a server error`);
    } else {
      await sleep(3000);
      const after = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
      console.log(`  query AFTER a SUCCESSFUL swap to an invalid token -> ${after.status}`);
      if (after.status === 200) {
        console.log(
          "  note: the swap was accepted, yet the query still succeeds with a known-invalid token - the old " +
            "credential may be cached somewhere past the change. First observation for HubSpot, worth confirming."
        );
      } else {
        console.log("  the invalid credential took effect - the query now fails.");
      }
      assert(after.status < 500, `Post-swap query returned ${after.status} - a server error`);
    }

    const delCat = await ctx.client.deleteCatalog(catalogId);
    assertStatusIn(delCat, [200, 400, 404], "deleteCatalog (cred-swap)");
    if (delCat.status === 200) untrack(ctx.createdCatalogIds, catalogId);
  });

  await step("deleteCatalog racing a syncing cache (gated: RUN_RISKY_RACES)", async () => {
    if (process.env.RUN_RISKY_RACES !== "true") {
      console.log(
        "skipped: set RUN_RISKY_RACES=true to run this. It can strand a cache that no endpoint lists, " +
          "which would need manual cleanup in Peaka."
      );
      return;
    }

    const { catalogId, connectionId } = await throwawayCatalog("cat-del");
    const cache = await ctx.client.createCache({
      catalogId,
      schemaName: ctx.schemaName,
      tableName: "contacts",
    });
    assertStatus(cache, 200, "createCache in the throwaway catalog");
    const cacheId = cache.body.id;
    ctx.createdCacheIds.push(cacheId);

    const outcome = await duringSync(ctx, cacheId, () => ctx.client.deleteCatalog(catalogId));
    console.log(
      `  deleteCatalog mid-sync -> ${outcome.result.status} (entered window: ${outcome.enteredWindow}, ` +
        `cache status at fire: ${outcome.statusAtFire})`
    );
    assert(outcome.result.status < 500, `deleteCatalog mid-sync returned ${outcome.result.status} - a server error`);
    if (outcome.result.status === 200) untrack(ctx.createdCatalogIds, catalogId);

    await sleep(5000);
    const all = await ctx.client.getAllCacheStatusesOfProject();
    assertStatus(all, 200, "getAllCacheStatusesOfProject after deleting the catalog");
    const stillListed = all.body.find((c) => c.id === cacheId);
    console.log(
      stillListed
        ? `  cache ${cacheId} is STILL LISTED (status ${stillListed.status}) after its catalog was deleted`
        : `  cache ${cacheId} no longer appears in the project listing`
    );

    const del = await ctx.client.deleteCache(cacheId);
    console.log(`  deleteCache after the catalog was removed -> ${del.status}`);
    if (del.status === 200) {
      untrack(ctx.createdCacheIds, cacheId);
    } else if (stillListed) {
      assert(
        false,
        `ORPHANED CACHE: ${cacheId} is still listed after its catalog was deleted but deleteCache returned ${del.status}.`
      );
    }

    await ctx.client.deleteConnection(connectionId).catch(() => {});
    untrack(ctx.createdConnectionIds, connectionId);
  });
}

module.exports = { runTier2Races };
