const { assertStatus, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError, recordServerError } = require("../../helpers/serverError");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");
const { duringSync, duringState, simultaneously, waitForSettled, sleep } = require("../../helpers/raceWindow");

const PARALLEL_QUERY_COUNT = 20;

// Metadata-refresh statuses are lower-kebab in practice (`not-active`) while
// the reference documents SCREAMING_SNAKE - normalise before comparing.
// Same divergence l-metadata.js handles.
function normalizeMetaStatus(raw) {
  return String(raw || "").toUpperCase().replace(/-/g, "_");
}
const META_TERMINAL = ["NOT_ACTIVE", "COMPLETED", "FAILED", "STUCK"];

/**
 * Tier 3 concurrency conflicts - metadata races and parallel load.
 *
 * NON-DESTRUCTIVE, unlike Tier 2: nothing here deletes a catalog or
 * connection it did not create. EVERY step that writes - the metadata
 * refreshes and the cache sync in 3.8b - runs against its own throwaway
 * catalog, so none of them can disturb B and C reading the shared one. The
 * parallel-query step is read-only and deliberately uses the shared catalog.
 *
 * That was not always true: 3.8b cached `customers` into PEAKA_CATALOG_ID
 * until 2026-08-03, which made this paragraph a claim the code did not honour.
 * If you add a step here that writes, give it a throwaway catalog too.
 *
 * The 20-parallel-query step also covers the instructor's scenario 19.
 */
async function runTier3Races(ctx) {
  await step("resolve catalog name", async () => {
    await resolveCatalogName(ctx);
  });

  /** Throwaway connection + catalog so metadata refreshes stay isolated. */
  async function throwawayCatalog(label) {
    const name = `e2e-auto-race3-${label}-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "stripe",
      credential: { token: ctx.token },
    });
    assertStatus(conn, 200, `createConnection(${label})`);
    ctx.createdConnectionIds.push(conn.body.id);
    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, `createCatalog(${label})`);
    ctx.createdCatalogIds.push(cat.body.id);
    return cat.body.id;
  }

  /** Polls a metadata refresh to a terminal state. */
  async function waitForMetaSettled(catalogId, maxAttempts = 40) {
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await ctx.client.getMetadataRefreshStatus(catalogId);
      if (res.status !== 200) return { settled: false, status: `HTTP_${res.status}` };
      last = normalizeMetaStatus(res.body.status);
      if (META_TERMINAL.includes(last)) return { settled: true, status: last };
      await sleep(2000);
    }
    return { settled: false, status: last };
  }

  // ---------------------------------------------------------------- TIER 3.8
  // The version of the original idea with real teeth: discovery reading
  // metadata while metadata is being REBUILT. (Reading table metadata during a
  // *cache* sync is the cheap sibling, covered in 3.8b below.)
  await step("listTables/listColumns while metadata is being refreshed", async () => {
    const catalogId = await throwawayCatalog("meta-read");

    // Establish what discovery returns before the refresh, so a degraded
    // result during it is recognisable rather than ambiguous.
    const before = await ctx.client.listTables(catalogId, ctx.schemaName);
    assertStatus(before, 200, "listTables baseline");
    const baselineCount = before.body.length;
    console.log(`  baseline: listTables returned ${baselineCount} tables`);

    const refresh = await ctx.client.refreshMetadata({ catalogId });
    assertStatus(refresh, 200, "refreshMetadata");

    // Fire discovery repeatedly while the refresh is in flight, and keep the
    // worst result seen - a single sample could easily miss a transient dip.
    const observations = [];
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const status = await ctx.client.getMetadataRefreshStatus(catalogId);
      const norm = normalizeMetaStatus(status.status === 200 ? status.body.status : "");
      const tables = await ctx.client.listTables(catalogId, ctx.schemaName);
      const cols = await ctx.client.listColumns(catalogId, ctx.schemaName, "customers");
      observations.push({
        metaStatus: norm,
        tablesStatus: tables.status,
        tableCount: tables.status === 200 ? tables.body.length : null,
        colsStatus: cols.status,
        colCount: cols.status === 200 ? cols.body.length : null,
      });
      if (META_TERMINAL.includes(norm)) break;
      await sleep(1000);
    }

    const during = observations.filter((o) => o.metaStatus === "ACTIVE" || o.metaStatus === "WAITING");
    console.log(`  ${observations.length} samples taken, ${during.length} of them mid-refresh`);
    if (during.length === 0) {
      console.log(
        "  inconclusive: never observed the refresh in a non-terminal state - it may complete faster than " +
          "one poll cycle on a fresh catalog. Invariants still checked."
      );
    }

    // Invariants: discovery must never 5xx during a refresh, and must never
    // return an EMPTY table list - a transient empty result is exactly the
    // shape of bug that would silently break anything doing discovery.
    for (const o of observations) {
      // These observations store bare status NUMBERS rather than response
      // objects, so they are wrapped - assertNoServerError only ever reads
      // .status and .body.
      assertNoServerError({ status: o.tablesStatus }, "listTables during a metadata refresh", {
        message: `listTables returned ${o.tablesStatus} during a metadata refresh`,
      });
      assertNoServerError({ status: o.colsStatus }, "listColumns during a metadata refresh", {
        message: `listColumns returned ${o.colsStatus} during a metadata refresh`,
      });
      if (o.tablesStatus === 200) {
        assert(
          o.tableCount > 0,
          `listTables returned an EMPTY list during a metadata refresh (metaStatus ${o.metaStatus}) - ` +
            `discovery is briefly reporting a catalog with no tables, which would silently break any caller`
        );
      }
      if (o.colsStatus === 200) {
        assert(
          o.colCount > 0,
          `listColumns returned an EMPTY column list during a metadata refresh (metaStatus ${o.metaStatus})`
        );
      }
    }

    const counts = [...new Set(observations.filter((o) => o.tableCount != null).map((o) => o.tableCount))];
    console.log(`  distinct table counts observed: ${counts.join(", ")} (baseline ${baselineCount})`);
    const settled = await waitForMetaSettled(catalogId);
    console.log(`  refresh settled at ${settled.status}`);
    assert(settled.settled, `Metadata refresh never settled (last: ${settled.status})`);
  });

  // ---------------------------------------------------------------- TIER 3.8b
  // The original idea as literally stated: listTables while a table is being
  // cached. Predicted safe - listTables reads catalog metadata, not table
  // data, so it never touches the syncing path. Worth one step to confirm the
  // prediction rather than assume it, since the *row-query* equivalent of this
  // is a confirmed bug.
  await step("listTables while a table is being cached (predicted safe)", async () => {
    // USES A THROWAWAY CATALOG, like every other step in this file.
    //
    // It used to cache `customers` into the shared PEAKA_CATALOG_ID, which is
    // exactly the hazard Tier 1 was moved off: an interruption between the
    // create and the delete below leaves `customers` cached in the catalog C
    // depends on. That is not hypothetical - a dashboard server died mid-run
    // once and left precisely that state behind, after which C skipped its
    // whole live phase, silently dropping the 100-row cap regression.
    //
    // It also made this file's own header untrue, which claimed Tier 3 could
    // not disturb B and C. An independent catalog on its own Stripe connection
    // holds the same `customers` rows and syncs in the same ~37s, so the race
    // window is unchanged.
    const raceCatalogId = await throwawayCatalog("cache-sync");
    assert(
      String(raceCatalogId) !== String(ctx.catalogId),
      "This step must never cache into the shared PEAKA_CATALOG_ID"
    );

    const cache = await ctx.client.createCache({
      catalogId: raceCatalogId,
      schemaName: ctx.schemaName,
      tableName: "customers",
    });
    assertStatus(cache, 200, "createCache(customers)");
    const cacheId = cache.body.id;
    ctx.createdCacheIds.push(cacheId);

    const outcome = await duringSync(ctx, cacheId, async () => {
      const tables = await ctx.client.listTables(raceCatalogId, ctx.schemaName);
      const cols = await ctx.client.listColumns(raceCatalogId, ctx.schemaName, "customers");
      return { tables, cols };
    });

    console.log(
      `  mid-sync (entered window: ${outcome.enteredWindow}): listTables -> ${outcome.result.tables.status} ` +
        `(${outcome.result.tables.status === 200 ? outcome.result.tables.body.length : "-"} tables), ` +
        `listColumns -> ${outcome.result.cols.status}`
    );
    assertStatus(outcome.result.tables, 200, "listTables during a cache sync");
    assertStatus(outcome.result.cols, 200, "listColumns during a cache sync");
    assert(outcome.result.tables.body.length > 0, "listTables returned an empty list during a cache sync");
    if (outcome.enteredWindow) {
      console.log("  prediction confirmed: metadata discovery is unaffected by an in-progress cache sync");
    }

    const settled = await waitForSettled(ctx, cacheId);
    assert(settled.settled, `Cache never settled (last: ${settled.status})`);
    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the listTables race");
    const i = ctx.createdCacheIds.indexOf(cacheId);
    if (i !== -1) ctx.createdCacheIds.splice(i, 1);
  });

  // ---------------------------------------------------------------- TIER 3.9
  await step("two metadata refreshes fired simultaneously", async () => {
    const catalogId = await throwawayCatalog("meta-dup");

    const [first, second] = await simultaneously([
      () => ctx.client.refreshMetadata({ catalogId }),
      () => ctx.client.refreshMetadata({ catalogId }),
    ]);

    for (const [label, o] of [["refresh #1", first], ["refresh #2", second]]) {
      if (!o.ok) {
        console.log(`  ${label} threw: ${o.error && o.error.message}`);
        continue;
      }
      console.log(`  ${label} -> ${o.value.status}`);
      assertNoServerError(o.value, label, {
        message: `${label} returned ${o.value.status} when raced - a server error`,
      });
    }

    // The invariant: overlapping refreshes must not wedge the catalog, and
    // discovery must still work afterwards.
    const settled = await waitForMetaSettled(catalogId);
    console.log(`  settled at ${settled.status}`);
    assert(settled.settled, `Catalog metadata never settled after two simultaneous refreshes (last: ${settled.status})`);

    const tables = await ctx.client.listTables(catalogId, ctx.schemaName);
    assertStatus(tables, 200, "listTables after two simultaneous refreshes");
    assert(tables.body.length > 0, "Catalog reports no tables after two simultaneous metadata refreshes");
    console.log(`  discovery intact afterwards: ${tables.body.length} tables`);
  });

  // ---------------------------------------------------------------- TIER 3.10
  // Also covers the instructor's scenario 19. Read-only.
  await step(`${PARALLEL_QUERY_COUNT} parallel queries degrade gracefully`, async () => {
    const sql = `SELECT id FROM "${ctx.catalogName}"."${ctx.schemaName}"."customers" LIMIT 1`;
    const startedAt = Date.now();
    const results = await simultaneously(
      Array.from({ length: PARALLEL_QUERY_COUNT }, () => () => ctx.client.executeQuery({ statement: sql }, "SIMPLE"))
    );
    const elapsed = Date.now() - startedAt;

    const byStatus = {};
    let threw = 0;
    for (const r of results) {
      if (!r.ok) {
        threw++;
        continue;
      }
      byStatus[r.value.status] = (byStatus[r.value.status] || 0) + 1;
    }
    console.log(
      `  ${PARALLEL_QUERY_COUNT} parallel queries in ${elapsed}ms -> ` +
        `${Object.entries(byStatus).map(([s, n]) => `${n}x${s}`).join(", ")}${threw ? `, ${threw} threw` : ""}`
    );

    // Invariants, matching the instructor's scenario 19: every query either
    // succeeds or fails with a meaningful 4xx (429 included). No 5xx, and
    // nothing hangs.
    const serverErrors = Object.keys(byStatus).filter((s) => Number(s) >= 500);
    // Recorded before asserting, and one record per DISTINCT status rather than
    // per response - this aggregates a histogram across N parallel queries, so
    // there is no single response object to hand to assertNoServerError. The
    // assert below still fails the step; this only makes the 5xx reach the run
    // banner and coverage.json as well.
    for (const status of serverErrors) {
      recordServerError({
        status: Number(status),
        label: "parallel query load",
        body: null,
        tolerated: false,
        context: `${byStatus[status]} of ${PARALLEL_QUERY_COUNT} parallel queries returned ${status}`,
      });
    }
    assert(
      serverErrors.length === 0,
      `Parallel load produced server errors: ${serverErrors.map((s) => `${byStatus[s]}x${s}`).join(", ")}. ` +
        `Under contention every request must still return a clean status.`
    );
    assert(threw === 0, `${threw} of ${PARALLEL_QUERY_COUNT} parallel queries threw at the transport level`);
    assert(
      elapsed < 60000,
      `${PARALLEL_QUERY_COUNT} parallel queries took ${elapsed}ms - over the 60s ceiling scenario 19 sets`
    );
    if (byStatus["429"]) {
      console.log(`  note: ${byStatus["429"]} request(s) were rate-limited with 429 - correct backpressure`);
    }
  });
}

module.exports = { runTier3Races };
