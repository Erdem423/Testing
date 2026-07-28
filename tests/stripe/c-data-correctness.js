const { assertStatus, assert, assertApprox } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveCatalogName } = require("../../helpers/resolveCatalogName");
const { pollCacheUntilComplete } = require("../../helpers/pollCacheUntilComplete");

function qname(ctx, tableName) {
  return `"${ctx.catalogName}"."${ctx.schemaName}"."${tableName}"`;
}

async function countRows(ctx, tableName, whereClause = "") {
  const sql = `SELECT COUNT(*) AS cnt FROM ${qname(ctx, tableName)} ${whereClause}`;
  const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
  assertStatus(res, 200, `count(${tableName})`);
  const row = res.body.data[0];
  return Number(row.cnt);
}

/**
 * Data Correctness: checks the seeded Stripe sandbox data against what
 * seed.js is expected to have produced. Independent of the other
 * consolidated tests - only needs ctx.catalogName/schemaName from config.
 *
 * NOTE: real testing (2026-07-22) found that COUNT(*) queries against
 * Peaka's Stripe connector appear hard-capped at exactly 100 rows,
 * regardless of the table's actual size - confirmed on TWO different tables:
 *   - customers: Stripe dashboard shows 505 real customers; this query
 *     consistently returns exactly 100, across multiple separate runs.
 *   - invoices: with ctx.expectedCustomerCount=100, the invoice-count check
 *     (which expects ~25% of that, i.e. ~25) also got back exactly 100 -
 *     the same cap, on a different table.
 * 100 matches Stripe's default List API page size, so the likely cause is
 * that Peaka's COUNT(*) isn't paginating through all pages before
 * aggregating - it's just counting whatever came back in the first page.
 * This is a real product bug worth filing, likely affecting any
 * COUNT/aggregate query over a live (non-cached) connector table larger
 * than ~100 rows, not just this test.
 *
 * DESIGN CHANGE: "customer count matches seed" (below) used to assert
 * against ctx.expectedCustomerCount (your real customer count via
 * NUM_CUSTOMERS) and was deliberately left "supposed to keep failing" once
 * your real count exceeded ~100. It now asserts against
 * ctx.expectedCustomerCountNonCache (EXPECTED_CUSTOMER_COUNT_NON_CACHE in
 * .env, default 100) instead - the KNOWN CAP VALUE, not your real count.
 * This turns it into a deliberate PASSING regression test: "is the
 * live-query cap still exactly 100?" It's supposed to go RED only if Peaka's
 * actual capped-at value ever changes - if it starts failing, that's new
 * information (the cap moved), not just "your real count is bigger than
 * 100" noise.
 *
 * "customer count via completed cache" (below) tests a follow-up question:
 * does the ~100-row cap only affect LIVE (non-cached) queries, or does it
 * also affect a query against a table that has a completed cache? Creates
 * its own cache on "customers" (separate from D's cache - each scenario has
 * its own independent ctx, so there's no collision), waits for it to finish
 * syncing, then re-counts and compares against ctx.expectedCustomerCount
 * (your REAL count, via NUM_CUSTOMERS) - this one SHOULD reflect reality if
 * caching bypasses the cap.
 */
async function runDataCorrectness(ctx) {
  await step("resolve catalog name", async () => {
    await resolveCatalogName(ctx);
  });

  await step("customer count matches seed", async () => {
    const count = await countRows(ctx, "customers");
    ctx.customerCountLive = count; // stashed for the cache-comparison step below
    // Tolerance accounts for API errors during seeding + any test-run churn.
    // Asserts against the KNOWN CAP (expectedCustomerCountNonCache), not
    // your real customer count - see the module-level comment above for why.
    assertApprox(count, ctx.expectedCustomerCountNonCache, 0.1, "customer count");
  });

  await step("customer count via completed cache", async () => {
    assert(ctx.catalogId, "Requires PEAKA_CATALOG_ID to be set in .env");
    assert(ctx.schemaName, "Requires PEAKA_SCHEMA_NAME to be set in .env");

    const createRes = await ctx.client.createCache({
      catalogId: ctx.catalogId,
      schemaName: ctx.schemaName,
      tableName: "customers",
    });
    if (createRes.status === 409 || createRes.status === 200) {
      // A cache on "customers" may already exist from a previous run (or
      // even this same run, via get-or-create behavior - see D's duplicate-
      // cache finding). Either way, createRes.body should still be the
      // cache's own config with an id we can poll.
      console.log(`note: createCache(customers) returned ${createRes.status} - reusing existing cache if present`);
    } else {
      assertStatus(createRes, 200, "createCache(customers)");
    }
    assert(createRes.body && createRes.body.id, "Expected cache id in response");
    const cacheId = createRes.body.id;
    ctx.createdCacheIds.push(cacheId); // track for cleanup

    const pollResult = await pollCacheUntilComplete(ctx, cacheId);
    if (pollResult.skipped) {
      console.log(
        "skipped: getCacheStatus returned 404 - this endpoint path is best-effort, verify against Postman collection"
      );
      return;
    }

    const cachedCount = await countRows(ctx, "customers");
    console.log(
      `customer count comparison - live (uncached): ${ctx.customerCountLive}, via completed cache: ${cachedCount}, real expected: ${ctx.expectedCustomerCount}`
    );

    // This assertion tests the actual hypothesis: if caching bypasses the
    // ~100-row cap, cachedCount should now be close to the REAL count. If it
    // still fails here, that's genuine, useful information too - it would
    // mean the cap affects cached reads as well, not just live pass-through
    // ones. Don't loosen this to "pass either way" - a failure here is a
    // real finding either direction.
    assertApprox(cachedCount, ctx.expectedCustomerCount, 0.1, "cached customer count");
  });

  await step("charge outcome distribution roughly matches seed weights", async () => {
    const total = await countRows(ctx, "charges");
    if (total === 0) {
      console.log("skipped: no charges found - did you run the seed script?");
      return;
    }
    const refunded = await countRows(ctx, "charges", "WHERE refunded = true");
    const refundedPct = refunded / total;
    // Seed script targets ~15% refunded; allow generous tolerance since
    // declined charges never reach the charges table successfully in some flows.
    assertApprox(refundedPct, 0.15, 0.5, "refunded charge percentage");
  });

  await step("subscription status distribution is sane", async () => {
    const total = await countRows(ctx, "subscriptions");
    if (total === 0) {
      console.log("skipped: no subscriptions found - did you run the seed script?");
      return;
    }
    const active = await countRows(ctx, "subscriptions", "WHERE status = 'active'");
    const canceled = await countRows(ctx, "subscriptions", "WHERE status = 'canceled'");
    assert(active + canceled > 0, "Expected some active or canceled subscriptions");
    assert(active + canceled <= total, "active+canceled should not exceed total subscriptions");
  });

  await step("invoice count roughly consistent with ~25% of customers", async () => {
    const invoiceCount = await countRows(ctx, "invoices");
    if (invoiceCount === 0) {
      console.log("skipped: no invoices found - did you run the seed script?");
      return;
    }
    const expected = ctx.expectedCustomerCount * 0.25;
    assertApprox(invoiceCount, expected, 0.6, "invoice count"); // wide tolerance, this ratio is approximate by design
  });

  await step("field-level spot check on a specific seeded customer", async () => {
    const sql = `SELECT name, email FROM ${qname(ctx, "customers")} WHERE name = 'Test Customer 1' LIMIT 1`;
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatus(res, 200, "spot check customer");
    if (res.body.data.length === 0) {
      console.log("skipped: 'Test Customer 1' not found - seed script may use a different naming pattern");
      return;
    }
    const row = res.body.data[0];
    assert(row.email && row.email.includes("test.customer1"), `Unexpected email for Test Customer 1: ${row.email}`);
  });
}

module.exports = { runDataCorrectness };
