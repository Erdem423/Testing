const { assertStatus, assertStatusIn, assert } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError } = require("../../helpers/serverError");
const { duringSync, waitForSettled, sleep } = require("../../helpers/raceWindow");
const { pollCacheUntilComplete } = require("../../helpers/pollCacheUntilComplete");

// Same reasoning as Tier 1: chosen because it syncs SLOWLY (~37s), which is
// what makes a window to fire into. Do not "optimise" this onto `transfers`
// (2.5s) - it would silently destroy the overlap.
const SLOW_TABLE = "customers";

const EXPORT_TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "CANCELED", "EXPIRED"];

// How many times the post-sync control export runs. More than one because
// export jobs fail INTERMITTENTLY on their own - measured 2026-08-04, the same
// uncached export came back FAILED once and SUCCEEDED twice in a row with no
// race involved. A single control cannot tell that apart from a real effect.
const CONTROL_RUNS = 3;

/**
 * Tier 4 - races that PERSIST WRONG DATA.
 *
 * Tiers 1-3 all ask a version of "does it error, or wedge?" - duplicate
 * createCache, deleteCache mid-sync, cancelling mid-flight, overlapping
 * refreshes. Every one of those is a transient failure that cleans up after
 * itself.
 *
 * None ask the question that actually harms a user: does the API silently write
 * something wrong DOWN and keep it? That is this suite's own headline finding in
 * a different guise - the 100-row cap is a silent truncation, not an error.
 *
 * The confirmed bug underneath is the Tier 1 canary's: querying a table's rows
 * while its cache syncs returns 0, because query routing prefers an existing
 * cache even before it holds data. Tiers 1-3 only ever observe that as a
 * transient read. Here it is used to build DURABLE artifacts - an export file, a
 * materialized snapshot, a cached row - and the question is whether the wrongness
 * outlives the race.
 *
 * ONE WINDOW, THREE ARTIFACTS. Tier 1's freshCache() costs two full syncs per
 * step; three steps that way would add ~4 minutes. Instead a single fresh cache
 * is created and all three conflicting operations fire inside that one RUNNING
 * window, then everything is inspected after it settles. Cheaper, and a closer
 * model of a busy system than three isolated windows.
 *
 * ASSERTIONS ARE INVARIANTS. Nothing documents what should happen here, so this
 * follows the pattern the other tiers use: report what happened, assert only
 * what must hold. A row count of 0 in an export is REPORTED, never asserted -
 * asserting 0 would institutionalise a bug, asserting non-zero would be
 * permanently red until Peaka fixes it.
 */
async function runTier4Races(ctx) {
  let catalogId = null;
  let catalogName = null;
  let cacheId = null;
  let exportQueryId = null;
  let exportId = null;
  let materializedId = null;
  let customerName = null;
  let customerId = null;
  let enteredWindow = false;

  const qualified = () => `"${catalogName}"."${ctx.schemaName}"."${SLOW_TABLE}"`;

  async function cachedCount() {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM ${qualified()}` },
      "SIMPLE"
    );
    return res.status === 200 ? Number(res.body.data[0].cnt) : null;
  }

  /** Polls an already-started export to a terminal state. Returns its last body. */
  async function pollExportToTerminal(id, label) {
    let last = null;
    for (let attempt = 1; attempt <= 40; attempt++) {
      const res = await ctx.client.getExport(id);
      assertNoServerError(res, "getExport", {
        message: `getExport (${label}) returned ${res.status} - a server error`,
      });
      last = res.body;
      if (res.status === 200 && EXPORT_TERMINAL.includes(String(res.body.status).toUpperCase())) break;
      await sleep(3000);
    }
    return last;
  }

  /** Starts a fresh export of the same query and polls it. Used for the controls. */
  async function runExportToTerminal(label) {
    const res = await ctx.client.createQueryExport(exportQueryId, { format: "CSV", limit: 1000 });
    assertStatusIn(res, [200, 202], `createQueryExport (${label})`);
    return pollExportToTerminal(res.body.id, label);
  }

  async function findCustomer() {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT name FROM ${qualified()} WHERE name = '${customerName}' LIMIT 1` },
      "SIMPLE"
    );
    return res.status === 200 && res.body.data.length > 0;
  }

  await step("provision an isolated catalog and a query to export", async () => {
    const name = `e2e-auto-race4-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "stripe",
      credential: { token: ctx.stripeToken },
    });
    assertStatus(conn, 200, "createConnection (tier 4 catalog)");
    ctx.createdConnectionIds.push(conn.body.id);

    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, "createCatalog (tier 4 catalog)");
    catalogId = cat.body.id;
    ctx.createdCatalogIds.push(catalogId);
    assert(
      String(catalogId) !== String(ctx.catalogId),
      "Tier 4 must never operate on the shared PEAKA_CATALOG_ID"
    );

    const read = await ctx.client.getCatalog(catalogId);
    assertStatus(read, 200, "getCatalog (tier 4 catalog)");
    catalogName = read.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(read.body)}`);

    // Created BEFORE the window - the export has to be startable the instant
    // the cache reports RUNNING, not built while the window ticks away.
    const q = await ctx.client.createQuery({
      displayName: `e2e-auto-race4-export-${ctx.runTag}`,
      inputQuery: `SELECT id, name FROM ${qualified()}`,
      queryType: "PLAIN",
    });
    assertStatus(q, 200, "createQuery (for the mid-sync export)");
    exportQueryId = q.body.id;
    ctx.createdQueryIds.push(exportQueryId);
  });

  // THE RACE ITSELF. Everything below this step only inspects what it produced.
  await step("build three durable artifacts while the cache is syncing", async () => {
    const created = await ctx.client.createCache({
      catalogId,
      schemaName: ctx.schemaName,
      tableName: SLOW_TABLE,
    });
    assertStatus(created, 200, `createCache(${SLOW_TABLE})`);
    cacheId = created.body.id;
    ctx.createdCacheIds.push(cacheId);

    customerName = `e2e-race4-${ctx.runTag}`;

    const outcome = await duringSync(ctx, cacheId, async () => {
      // Sequential, not parallel, so each result is attributable.
      const exp = await ctx.client.createQueryExport(exportQueryId, { format: "CSV", limit: 1000 });

      const cust = await ctx.stripe.createCustomer({
        name: customerName,
        email: `${customerName}@example.invalid`,
      });
      // Tracked the instant it exists - cleanup must own it even if the rest
      // of this scenario throws.
      if (cust.ok && cust.body && cust.body.id) ctx.createdStripeCustomerIds.push(cust.body.id);

      const mat = await ctx.client.createQuery({
        displayName: `e2e-auto-race4-matq-${ctx.runTag}`,
        inputQuery: `SELECT id, name FROM ${qualified()}`,
        queryType: "MATERIALIZED",
      });
      if (mat.status === 200 && mat.body && mat.body.id) ctx.createdQueryIds.push(mat.body.id);

      return { exp, cust, mat };
    });

    enteredWindow = outcome.enteredWindow;
    const { exp, cust, mat } = outcome.result;
    exportId = exp.status < 300 && exp.body ? exp.body.id : null;
    customerId = cust.ok && cust.body ? cust.body.id : null;
    materializedId = mat.status === 200 && mat.body ? mat.body.id : null;

    console.log(
      `fired inside the sync window (entered: ${enteredWindow}, cache status at fire: ${outcome.statusAtFire}):`
    );
    console.log(`  createQueryExport -> ${exp.status} (export ${exportId})`);
    console.log(`  stripe createCustomer -> ${cust.status} (${customerId})`);
    console.log(`  createQuery(MATERIALIZED) -> ${mat.status} (${materializedId})`);

    // None of these should be server errors, whoever won the race.
    assertStatusIn(exp, [200, 202], "createQueryExport during a cache sync");
    assert(cust.ok, `Stripe createCustomer failed during the race: ${JSON.stringify(cust.body).slice(0, 200)}`);
    assertStatus(mat, 200, "createQuery(MATERIALIZED) during a cache sync");

    if (!enteredWindow) {
      console.log(
        "WINDOW MISSED - the sync finished before the artifacts were created, so the results below " +
          "describe a quiet system rather than a race. Invariants are still checked."
      );
    }

    // Let the cache finish before inspecting anything.
    const settled = await waitForSettled(ctx, cacheId, { pollMs: 3000, maxAttempts: 60 });
    assert(settled.settled, `The cache never settled after the race (last: ${settled.status})`);
    console.log(`  cache settled at ${settled.status}; cached count is now ${await cachedCount()}`);
  });

  // ---------------------------------------------------------------- TIER 4.1
  await step("an export started mid-sync reports what it captured", async () => {
    assert(exportId, "No export id - the export could not be started during the race");

    // Already started inside the window, so this only polls it.
    const last = await pollExportToTerminal(exportId, "mid-sync export");
    const racedStatus = last && String(last.status).toUpperCase();
    const racedRows = last && last.rowCount != null ? Number(last.rowCount) : null;
    console.log(
      `mid-sync export settled at ${racedStatus} with rowCount ${racedRows === null ? "(absent)" : racedRows}`
    );

    // The invariant: the job must finish rather than hang, whatever it captured.
    assert(
      last && EXPORT_TERMINAL.includes(racedStatus),
      `The export never reached a terminal state after racing a cache sync (last: ${JSON.stringify(last)})`
    );

    // CONTROLS, PLURAL - and the plural is the whole point.
    //
    // This step used to run ONE control, which was defensible while exports
    // looked reliable. They are not: probing on 2026-08-04 had the SAME export
    // of `charges` come back FAILED once and SUCCEEDED twice in quick
    // succession, uncached, with no race anywhere. A one-versus-one comparison
    // therefore cannot separate "the sync broke it" from "exports fail
    // sometimes" - it just shows a difference and invites the wrong conclusion.
    //
    // Three controls make each run self-diagnosing: 3/3 success against a
    // failed raced export is a signal worth repeating; 2/3 is visibly noise.
    // The raced side stays a single trial deliberately - repeating it needs a
    // fresh ~37s sync each time, minutes for a marginal step.
    const controls = [];
    for (let run = 1; run <= CONTROL_RUNS; run++) {
      controls.push(await runExportToTerminal(`control ${run}`));
    }
    const controlStatuses = controls.map((c) => (c ? String(c.status).toUpperCase() : "NO_RESULT"));
    const controlsSucceeded = controlStatuses.filter((s) => s === "SUCCEEDED").length;
    const controlRows = controls
      .map((c) => (c && c.rowCount != null ? Number(c.rowCount) : null))
      .find((n) => n !== null);
    console.log(
      `control exports (cache settled): ${controlsSucceeded}/${CONTROL_RUNS} succeeded ` +
        `[${controlStatuses.join(", ")}], rowCount ${controlRows === undefined ? "(absent)" : controlRows}`
    );

    // REPORTED, NOT ASSERTED - the same reasoning as Tier 1's duplicate-create
    // step. Asserting the broken outcome institutionalises it; asserting the
    // healthy one stays red until Peaka fixes it.
    const allControlsPassed = controlsSucceeded === CONTROL_RUNS;
    if (!enteredWindow) {
      console.log("window was missed, so the comparison above describes a quiet system rather than a race");
    } else if (racedStatus === "SUCCEEDED" && racedRows === 0 && controlRows > 0) {
      console.log(
        `FINDING: an export started while the table's cache was syncing SUCCEEDED with rowCount 0, while ` +
          `the controls captured ${controlRows}. An empty mid-sync read is now a downloadable file that ` +
          `reports success.`
      );
    } else if (racedStatus === "FAILED" && allControlsPassed) {
      console.log(
        `OBSERVED: the mid-sync export FAILED while ${CONTROL_RUNS}/${CONTROL_RUNS} identical exports ` +
          `after the sync SUCCEEDED (${controlRows} rows). Suggestive but still one trial on the raced ` +
          `side - exports do fail intermittently, so repeat across runs before attributing this to the sync.`
      );
    } else if (racedStatus === "FAILED" && !allControlsPassed) {
      console.log(
        `NOT ATTRIBUTABLE: the mid-sync export FAILED, but so did ${CONTROL_RUNS - controlsSucceeded} of ` +
          `${CONTROL_RUNS} controls with no race involved. This run says nothing about the sync - it is ` +
          `the intermittent export failure showing up on both sides.`
      );
    } else if (racedStatus === "SUCCEEDED" && allControlsPassed) {
      console.log(`no difference: the raced export and all ${CONTROL_RUNS} controls succeeded`);
    }
  });

  // ---------------------------------------------------------------- TIER 4.2
  // THE STRONGEST STEP HERE, and only possible since helpers/stripeClient.js
  // existed. A watermark-based sync that advances past a row written DURING the
  // sync would never pick that row up again - the row would be permanently lost
  // rather than merely late. That is the difference this step exists to find.
  await step("a source row created mid-sync is never permanently lost", async () => {
    assert(customerId, "No Stripe customer id - the customer could not be created during the race");

    let via = (await findCustomer()) ? "the sync itself" : null;

    if (!via) {
      console.log("not picked up by the sync that was running; trying a follow-up incremental");
      const inc = await ctx.client.triggerIncrementalUpdate(cacheId);
      assertStatus(inc, 200, "triggerIncrementalUpdate (follow-up)");
      await pollCacheUntilComplete(ctx, cacheId);
      if (await findCustomer()) via = "a follow-up incremental";
    }

    if (!via) {
      console.log("still absent after an incremental; trying a full refresh");
      const full = await ctx.client.triggerFullRefresh(cacheId);
      assertStatus(full, 200, "triggerFullRefresh (follow-up)");
      await pollCacheUntilComplete(ctx, cacheId);
      if (await findCustomer()) via = "a full refresh";
    }

    assert(
      via,
      `'${customerName}' was created in Stripe DURING a cache sync and is still missing after the sync ` +
        `completed, a follow-up incremental, AND a full refresh. A row written during a sync has been ` +
        `permanently lost - the sync's watermark appears to have advanced past it. This is the worst ` +
        `outcome this tier tests for.`
    );
    console.log(`the mid-sync row became visible via ${via}`);

    if (via === "a full refresh") {
      console.log(
        `FINDING: a row created during a sync was invisible to incremental updates and only appeared ` +
          `after a FULL REFRESH. Incremental syncs alone would never surface it.`
      );
    }
  });

  // ---------------------------------------------------------------- TIER 4.3
  // A materialized query is a STORED SNAPSHOT - verified 2026-08-04 by adding a
  // row upstream and confirming executeQuery({ id }) did not show it without a
  // refresh. So whatever it captured mid-sync, it keeps.
  //
  // NOTE THE BASELINE, because it makes this step subtler than it looks: a
  // materialized query over an UNCACHED table already captures only 100 rows of
  // 505 - the live cap, frozen. That happens with no race at all. This step asks
  // whether racing a sync makes it worse still.
  await step("a materialized query built mid-sync reports what it captured", async () => {
    assert(materializedId, "No materialized query id - it could not be created during the race");

    // Wait for the materialization to finish before reading it.
    for (let attempt = 1; attempt <= 45; attempt++) {
      const res = await ctx.client.getMaterializedQueryStatus(materializedId);
      if (res.status === 200 && String(res.body.status).toUpperCase() !== "RUNNING") break;
      await sleep(2000);
    }

    const snapshot = await ctx.client.executeQuery({ id: materializedId }, "SIMPLE");
    assertNoServerError(snapshot, "Reading the materialized snapshot", {
      message: `Reading the materialized snapshot returned ${snapshot.status}`,
    });

    if (snapshot.status !== 200) {
      console.log(`materialized snapshot could not be read (${snapshot.status}) - reported, not asserted`);
      return;
    }

    const rows = snapshot.body.data.length;
    const cached = await cachedCount();
    console.log(`materialized snapshot holds ${rows} rows; the cache now holds ${cached}`);

    if (enteredWindow && rows === 0) {
      console.log(
        `FINDING: a materialized query created while its source table was syncing captured ZERO rows, ` +
          `permanently. Nothing about the query indicates its data is wrong.`
      );
    } else if (rows > 0 && cached !== null && rows < cached) {
      console.log(
        `NOTE: the snapshot holds ${rows} rows against ${cached} in the cache. Expected even without a ` +
          `race - a materialized query over an uncached table captures the 100-row live cap - but worth ` +
          `confirming the number matches the cap rather than something stranger.`
      );
    }
  });

  await step("the cache is still healthy and deletable afterwards", async () => {
    const status = await ctx.client.getCacheStatus(cacheId);
    assertStatus(status, 200, "getCacheStatus after the race");

    const del = await ctx.client.deleteCache(cacheId);
    assertStatus(del, 200, "deleteCache after the race");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });
}

module.exports = { runTier4Races };
