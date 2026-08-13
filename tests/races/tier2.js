const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { duringSync, duringExport, simultaneously, sleep } = require("../../helpers/raceWindow");

const BAD_TOKEN = "sk_test_deliberately_invalid_for_race_testing";

/**
 * Tier 2 concurrency conflicts - cross-resource races that test dependency
 * ordering. See CONCURRENCY-SPEC.md.
 *
 * SAFETY: every scenario here creates its OWN connection and catalog and
 * deletes only those. Nothing touches PEAKA_CATALOG_ID or the connection
 * behind it - several of these steps delete a catalog or connection outright,
 * so operating on the shared one would break every other test in the repo.
 *
 * Scenario 4 (deleteCatalog mid-sync) can strand a cache that no endpoint
 * enumerates - the schema-level status endpoint returns 500, so orphans may be
 * neither listable nor deletable. It is therefore gated behind
 * RUN_RISKY_RACES=true and skipped by default.
 *
 * Assertions are invariants, not expected values: nothing documents what
 * should happen when you delete a connection mid-query, and the race may not
 * fire at all.
 */
async function runTier2Races(ctx) {
  /** Throwaway connection + catalog, tracked for cleanup. Returns its queryable name. */
  async function throwawayCatalog(label) {
    const name = `e2e-auto-race-${label}-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "stripe",
      credential: { token: ctx.stripeToken },
    });
    assertStatus(conn, 200, `createConnection(${label})`);
    ctx.createdConnectionIds.push(conn.body.id);

    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, `createCatalog(${label})`);
    ctx.createdCatalogIds.push(cat.body.id);

    // The queryable slug is `name`, distinct from displayName.
    const read = await ctx.client.getCatalog(cat.body.id);
    assertStatus(read, 200, `getCatalog(${label})`);
    return { connectionId: conn.body.id, catalogId: cat.body.id, catalogName: read.body.name };
  }

  function untrack(arr, value) {
    const i = arr.indexOf(value);
    if (i !== -1) arr.splice(i, 1);
  }

  // ---------------------------------------------------------------- TIER 2.5
  // Queries against this connector return in ~1-2s, far too fast to reliably
  // land a delete "inside" one. So this is a Pattern B symmetric race: fire
  // both at once and report who won, rather than pretending to enter a window.
  await step("deleteConnection racing an in-flight query", async () => {
    const { connectionId, catalogId, catalogName } = await throwawayCatalog("conn-del");
    const sql = `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${ctx.schemaName}"."customers"`;

    // BASELINE FIRST, and it is load-bearing. Without it a 4xx from the raced
    // query is uninterpretable - it could mean "the connection was already
    // gone" or simply "this freshly created catalog is not queryable yet
    // because metadata discovery hasn't finished". Establishing that the query
    // works BEFORE the race is what makes the raced result mean anything.
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

    // The invariant: after the dust settles, querying through a catalog whose
    // connection is gone must fail CLEANLY - a 4xx with a message, not a 5xx
    // and not a hang.
    await sleep(2000);
    const after = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    console.log(`  post-race query -> ${after.status}`);
    assert(
      after.status < 500,
      `Querying through a catalog whose connection was deleted returned ${after.status}: ` +
        `${JSON.stringify(after.body).slice(0, 200)}. A dead connection must produce a clean 4xx.`
    );
    if (baseline.status === 200) {
      // Only meaningful when the baseline proved the catalog WAS queryable.
      assert(
        after.status !== 200,
        `The catalog was queryable before its connection was deleted and still returns 200 afterwards - ` +
          `either the delete didn't take effect or connector state is cached past it.`
      );
      console.log("  confirmed: queryable before the delete, cleanly failing after it");
    }

    const delCat = await ctx.client.deleteCatalog(catalogId);
    assertStatusIn(delCat, [200, 400, 404], "deleteCatalog after its connection was removed");
    if (delCat.status === 200) untrack(ctx.createdCatalogIds, catalogId);
  });

  // ---------------------------------------------------------------- TIER 2.6
  // Export jobs are async and take a few seconds, so unlike queries there is a
  // real window here - fire the delete while the job is PENDING/RUNNING.
  await step("deleteQuery racing its own running export", async () => {
    const created = await ctx.client.createQuery({
      displayName: `e2e-auto-race-export-${ctx.runTag}`,
      // Real SQL so the export has actual work to do.
      inputQuery: `SELECT id, email FROM "${ctx.catalogNameFromConfig || "stripe"}"."${ctx.schemaName}"."customers"`,
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

    // The invariant: the export job must reach a terminal state rather than
    // hanging forever now that the query it referenced is gone.
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
      `Export never reached a terminal state after its query was deleted (last: ${finalStatus}) - ` +
        `deleting a query appears to orphan its in-flight export`
    );
  });

  // ---------------------------------------------------------------- TIER 2.7
  // Two things at once: the race itself, and - more valuable - whether the
  // credential swap actually takes effect. If queries keep succeeding with a
  // known-bad token, the old credential is cached somewhere it shouldn't be.
  // That is the untested half of the instructor's scenario 05.
  await step("updateConnection to a bad token racing a query", async () => {
    const { connectionId, catalogId, catalogName } = await throwawayCatalog("cred-swap");
    const sql = `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${ctx.schemaName}"."customers"`;

    const baseline = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    console.log(`  baseline query with a good token -> ${baseline.status}`);

    const [query, update] = await simultaneously([
      () => ctx.client.executeQuery({ statement: sql }, "SIMPLE"),
      () =>
        ctx.client.updateConnection(connectionId, {
          name: `e2e-auto-race-cred-swap-${ctx.runTag}`,
          type: "stripe",
          credential: { token: BAD_TOKEN },
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

    // CRITICAL DISTINCTION, and the first version of this step got it wrong:
    // if updateConnection was REJECTED, the connection still holds the good
    // token, so a subsequent query succeeding proves nothing at all. Only
    // interpret the post-swap query when the swap actually took.
    if (!swapSucceeded) {
      const status = update.ok ? update.value.status : "threw";
      console.log(
        `  updateConnection was rejected (${status}) - Peaka validates the credential on update rather than ` +
          `accepting it blindly, which is good behaviour. It also means the "is the old credential cached?" ` +
          `question cannot be probed this way: it needs a token that is well-formed AND accepted at update ` +
          `time but unauthorised at query time (e.g. a revoked key), not an obviously fake one.`
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
          "  FINDING: the swap was accepted, yet the query still succeeds with a known-invalid token - " +
            "the old credential is cached somewhere past the change. The instructor's scenario 05 treats " +
            "this as a bug. Reported rather than asserted pending confirmation by hand."
        );
      } else {
        console.log("  the invalid credential took effect - the query now fails, as scenario 05 expects.");
      }
      assert(after.status < 500, `Post-swap query returned ${after.status} - a server error`);
    }

    const delCat = await ctx.client.deleteCatalog(catalogId);
    assertStatusIn(delCat, [200, 400, 404], "deleteCatalog (cred-swap)");
    if (delCat.status === 200) untrack(ctx.createdCatalogIds, catalogId);
  });

  // ---------------------------------------------------------------- TIER 2.4
  // GATED. Deleting a catalog while a cache on it syncs can strand a cache
  // that nothing enumerates: the schema-level status endpoint returns 500, and
  // if the project-level listing doesn't show it either, it is neither
  // findable nor deletable without Peaka's help. Opt in explicitly.
  await step("deleteCatalog racing a syncing cache (gated: RUN_RISKY_RACES)", async () => {
    if (process.env.RUN_RISKY_RACES !== "true") {
      console.log(
        "skipped: set RUN_RISKY_RACES=true to run this. It can strand a cache that no endpoint lists " +
          "(the schema-level status endpoint returns 500), which would need manual cleanup in Peaka."
      );
      return;
    }

    const { catalogId, connectionId } = await throwawayCatalog("cat-del");
    // Caching `customers` in THIS throwaway catalog, not the shared one - the
    // two are independent copies, so C is unaffected either way.
    const cache = await ctx.client.createCache({
      catalogId,
      schemaName: ctx.schemaName,
      tableName: "customers",
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

    // Orphan check: is the cache still enumerable at project level?
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
      // Listed but not deletable is the genuinely bad outcome.
      assert(
        false,
        `ORPHANED CACHE: ${cacheId} is still listed after its catalog was deleted but deleteCache returned ` +
          `${del.status}. It needs manual cleanup in Peaka Studio.`
      );
    }

    await ctx.client.deleteConnection(connectionId).catch(() => {});
    untrack(ctx.createdConnectionIds, connectionId);
  });
}

module.exports = { runTier2Races };
