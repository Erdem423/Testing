const { assertStatus, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { pollCacheUntilComplete } = require("../../helpers/pollCacheUntilComplete");

const FRESHNESS_TABLE = "customers";

/**
 * Data freshness: does a cache refresh actually pick up a row added at the
 * SOURCE?
 *
 * This is the half of the refresh story no other scenario tells. `M` proves the
 * trigger/cancel endpoints respond correctly, but a refresh that returns 200 and
 * silently fetches nothing new would pass every assertion in `M`. The question a
 * user actually has - "I added a customer in Stripe, why can't I see it?" - is
 * only answerable by adding one and looking.
 *
 * THE ONLY SCENARIO THAT WRITES UPSTREAM. It creates a real Stripe customer via
 * helpers/stripeClient.js, then deletes it. Two consequences worth knowing:
 *
 *   - The id is tracked on ctx.createdStripeCustomerIds the instant it exists,
 *     so cleanup owns it even if a later step throws. A leftover customer
 *     permanently shifts the counts C asserts against.
 *   - While it exists, the account holds 506 customers rather than 505. C's
 *     cached-count check allows 10%, and its live counts are capped at 100
 *     regardless, so neither can be disturbed by this running alongside.
 *
 * RUNS IN ITS OWN CATALOG, for the same reason M, N and L do: it caches
 * `customers`, which is one of the four tables C caches in the shared catalog.
 *
 * INCREMENTAL IS TRIED FIRST, THEN FULL REFRESH. It is genuinely unknown whether
 * Peaka's Stripe connector incremental sync detects inserts. Rather than assume,
 * this reports which mechanism worked and asserts only the invariant that
 * matters to a caller: the new row becomes visible after SOME refresh. If
 * incremental turns out to miss inserts, that is a product finding worth
 * documenting - not a permanently red test.
 */
async function runDataFreshness(ctx) {
  let catalogId = null;
  let catalogName = null;
  let cacheId = null;
  let customerId = null;
  let customerName = null;
  let baselineCount = null;
  let foundVia = null;

  const qualified = () => `"${catalogName}"."${ctx.schemaName}"."${FRESHNESS_TABLE}"`;

  /** Counts rows in the cached table. */
  async function cachedCount() {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM ${qualified()}` },
      "SIMPLE"
    );
    assertStatus(res, 200, "COUNT(*) on the cached customers table");
    return Number(res.body.data[0].cnt);
  }

  /** Looks for the new customer by exact name. Returns the row or null. */
  async function findNewCustomer() {
    const res = await ctx.client.executeQuery(
      { statement: `SELECT id, name, email FROM ${qualified()} WHERE name = '${customerName}' LIMIT 1` },
      "SIMPLE"
    );
    assertStatus(res, 200, `SELECT ... WHERE name = '${customerName}'`);
    return res.body.data.length > 0 ? res.body.data[0] : null;
  }

  await step("provision an isolated catalog", async () => {
    const name = `e2e-auto-fresh-${ctx.runTag}`;
    const conn = await ctx.client.createConnection({
      name,
      type: "stripe",
      credential: { token: ctx.stripeToken },
    });
    assertStatus(conn, 200, "createConnection (freshness catalog)");
    ctx.createdConnectionIds.push(conn.body.id);

    const cat = await ctx.client.createCatalog({ name, connectionId: conn.body.id });
    assertStatus(cat, 200, "createCatalog (freshness catalog)");
    catalogId = cat.body.id;
    ctx.createdCatalogIds.push(catalogId);
    assert(
      String(catalogId) !== String(ctx.catalogId),
      "This scenario must never cache into the shared PEAKA_CATALOG_ID"
    );

    const read = await ctx.client.getCatalog(catalogId);
    assertStatus(read, 200, "getCatalog (freshness catalog)");
    catalogName = read.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(read.body)}`);
  });

  await step("cache the customers table and record a baseline count", async () => {
    const created = await ctx.client.createCache({
      catalogId,
      schemaName: ctx.schemaName,
      tableName: FRESHNESS_TABLE,
    });
    assertStatus(created, 200, `createCache(${FRESHNESS_TABLE})`);
    cacheId = created.body.id;
    ctx.createdCacheIds.push(cacheId);

    await pollCacheUntilComplete(ctx, cacheId);

    baselineCount = await cachedCount();
    // Reading from cache, so this is the REAL count, not the 100-row live cap.
    assert(
      baselineCount > ctx.expectedCustomerCountNonCache,
      `Expected the cached count (${baselineCount}) to exceed the live cap ` +
        `(${ctx.expectedCustomerCountNonCache}) - if it doesn't, this is reading live data and the rest ` +
        `of this scenario would be measuring the cap rather than freshness`
    );
    console.log(`baseline: ${baselineCount} customers in the cache`);
  });

  await step("create a new customer directly in Stripe", async () => {
    customerName = `e2e-freshness-${ctx.runTag}`;
    const res = await ctx.stripe.createCustomer({
      name: customerName,
      email: `${customerName}@example.invalid`,
    });
    assert(
      res.ok && res.body && res.body.id,
      `Stripe createCustomer failed (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`
    );
    customerId = res.body.id;
    // TRACKED IMMEDIATELY, before any assertion that could throw - cleanup must
    // own this even if everything below fails.
    ctx.createdStripeCustomerIds.push(customerId);
    assert(/^cus_/.test(customerId), `Expected a 'cus_'-prefixed Stripe id, got ${customerId}`);
    console.log(`created Stripe customer ${customerId} (${customerName})`);
  });

  // THE POINT OF THE WHOLE SCENARIO. Before any refresh, the cache is a
  // snapshot taken before the customer existed, so it must NOT be visible.
  // Without this the freshness check below could pass trivially - if the query
  // somehow read live data, the customer would be there all along and the
  // refresh would prove nothing.
  await step("the new customer is not visible before a refresh", async () => {
    const found = await findNewCustomer();
    assert(
      found === null,
      `'${customerName}' is already visible in the cache before any refresh was triggered. That means ` +
        `this query is not reading the cached snapshot, so the freshness result below would be ` +
        `meaningless. Got: ${JSON.stringify(found)}`
    );
    assertEqual(await cachedCount(), baselineCount, "cached count before any refresh");
  });

  await step("an incremental update is tried first", async () => {
    const res = await ctx.client.triggerIncrementalUpdate(cacheId);
    assertStatus(res, 200, "triggerIncrementalUpdate");
    await pollCacheUntilComplete(ctx, cacheId);

    const found = await findNewCustomer();
    if (found) {
      foundVia = "incremental";
      console.log(`incremental update picked up the new customer: ${JSON.stringify(found)}`);
    } else {
      console.log(
        "incremental update did NOT pick up the new customer. Not a failure on its own - Peaka's Stripe " +
          "incremental sync may not detect inserts. Trying a full refresh next; if that works, the " +
          "difference is a product finding worth recording in FINDINGS.md."
      );
    }
  });

  await step("a full refresh is tried if incremental missed it", async () => {
    if (foundVia === "incremental") {
      console.log("skipped: incremental already made the row visible, so there is nothing to fall back to");
      return;
    }
    const res = await ctx.client.triggerFullRefresh(cacheId);
    assertStatus(res, 200, "triggerFullRefresh");
    await pollCacheUntilComplete(ctx, cacheId);

    if (await findNewCustomer()) {
      foundVia = "fullRefresh";
      console.log("full refresh picked up the new customer, incremental did not");
    }
  });

  // THE INVARIANT. Which mechanism worked is reported, not asserted - that is
  // Peaka's behaviour and may legitimately differ. What must hold is that a
  // row added at the source becomes visible after refreshing, because a cache
  // that can never see new data is not a cache, it is a stale copy.
  await step("a source row becomes visible after refreshing", async () => {
    assert(
      foundVia !== null,
      `The customer '${customerName}' (${customerId}) was created in Stripe but never became visible ` +
        `in the cache after BOTH an incremental update and a full refresh. Either refreshes do not pull ` +
        `new source rows at all, or they complete before the upstream data is readable. This is the ` +
        `scenario's core assertion and a genuine bug if it fires.`
    );
    console.log(`freshness confirmed via ${foundVia}`);

    // Exactly one more row - catches a refresh that duplicates rows rather
    // than reconciling them, which a "is it there?" check alone would miss.
    const after = await cachedCount();
    assertEqual(after, baselineCount + 1, `cached count after adding one customer (via ${foundVia})`);
  });

  await step("deleting the customer upstream is reflected after a refresh", async () => {
    const del = await ctx.stripe.deleteCustomer(customerId);
    assert(del.ok, `Stripe deleteCustomer failed (${del.status}): ${JSON.stringify(del.body).slice(0, 200)}`);
    // Deleted upstream, so drop it from cleanup's list - deleting it twice
    // would log a spurious warning.
    ctx.createdStripeCustomerIds = ctx.createdStripeCustomerIds.filter((id) => id !== customerId);

    // The mirror image of the check above: a cache that notices inserts but
    // never notices deletions is just as stale, and full refresh is the
    // mechanism most likely to reconcile it.
    const res = await ctx.client.triggerFullRefresh(cacheId);
    assertStatus(res, 200, "triggerFullRefresh (after upstream delete)");
    await pollCacheUntilComplete(ctx, cacheId);

    const stillThere = await findNewCustomer();
    const after = await cachedCount();
    if (stillThere) {
      console.log(
        `FINDING: '${customerName}' was deleted in Stripe but is STILL in the cache after a full ` +
          `refresh (count ${after}, baseline ${baselineCount}). A full refresh appears not to remove ` +
          `rows that vanished upstream. Reported rather than asserted - confirm by hand before filing.`
      );
    } else {
      console.log(`upstream delete reflected after a full refresh (count back to ${after})`);
      assertEqual(after, baselineCount, "cached count after the customer was deleted upstream");
    }
  });

  await step("delete the cache", async () => {
    const res = await ctx.client.deleteCache(cacheId);
    assertStatus(res, 200, "deleteCache");
    ctx.createdCacheIds = ctx.createdCacheIds.filter((id) => id !== cacheId);
  });
}

module.exports = { runDataFreshness };
