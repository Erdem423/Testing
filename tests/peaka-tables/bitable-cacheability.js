const { assert, assertEqual, assertStatusIn } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { assertNoServerError } = require("../../helpers/serverError");

/**
 * Cache creation against an internal table, which fails before it can refuse.
 *
 * THE POSTGRES EQUIVALENT IS THE REFERENCE. PG-A asserts two halves: the
 * metadata says non-cacheable, AND createCache acts on it - returning a clean
 * 400 with errorCode TABLE_NOT_CACHEABLE. A flag can be stale; a rejection
 * cannot, which is why both halves are worth having.
 *
 * INTERNAL TABLES ONLY MANAGE THE FIRST HALF. Measured 2026-08-13 against both
 * kinds, empty and populated:
 *
 *   isCacheable                      -> false, supportedCacheTypes []  (correct)
 *   createCache(schema "bitable")    -> 400 "cannot find table or properties:
 *                                       \"table0658...\" in schema:
 *                                       \"schemamapper9lbuaggx...\"", errorCode null
 *   createCache(schema "table")      -> the same shape, different mangled id
 *
 * So the request never reaches the cacheability check at all. It dies looking
 * up an internal, mangled table identifier, and the caller gets a message about
 * Peaka's own storage layout instead of an answer to the question they asked.
 *
 * WHY THAT MATTERS RATHER THAN BEING A CURIOSITY. errorCode is null, so a
 * client written the way PG-A is - "try to cache, handle TABLE_NOT_CACHEABLE" -
 * has nothing to branch on and must string-match a message describing internal
 * schema names. It is also the SECOND place today where a createCache rejection
 * came back with errorCode null for an unrelated internal reason (FINDINGS 28
 * is the first, on a table carrying a Postgres comment), which makes it a
 * pattern in that endpoint rather than a one-off.
 *
 * NEEDS NO FIXTURE AND THEREFORE NO GATE. Cacheability does not depend on rows,
 * so this creates its own throwaway BI Table and runs in any project - unlike
 * the other BI Table scenarios, which need Studio-entered data.
 */
const REQUESTED_NAME = "e2eautobicache";

async function runBiTableCacheability(ctx) {
  let storedName = REQUESTED_NAME;

  await step("clean up any leftover BI Table from a previous run", async () => {
    await ctx.client.deleteBiTable(REQUESTED_NAME).catch(() => {});
  });

  await step("create a throwaway BI Table", async () => {
    const res = await ctx.client.createBiTable(REQUESTED_NAME);
    assertStatusIn(res, [200], "createBiTable");
    // Always track the name the RESPONSE returns - BI Table strips underscores
    // (FINDINGS 13). This name has none, so they should match; asserting that
    // keeps the scenario honest if the stripping rule ever widens.
    storedName = (res.body && (res.body.tableName || res.body.name)) || REQUESTED_NAME;
    ctx.createdBiTableNames.push(storedName);
    assertEqual(storedName, REQUESTED_NAME, "the stored BI Table name (no underscores to strip)");
  });

  await step("the BI Table reports itself as not cacheable", async () => {
    const res = await ctx.client.listBiTables();
    assertStatusIn(res, [200], "listBiTables");
    const entry = (res.body || []).find((t) => t.tableName === storedName);
    assert(entry, `'${storedName}' is not in listBiTables()`);

    assertEqual(entry.isCacheable, false, "isCacheable on a BI Table");
    assertEqual(
      (entry.supportedCacheTypes || []).length,
      0,
      `supportedCacheTypes on a non-cacheable BI Table. A table advertising cache types while reporting ` +
        `isCacheable:false would be a contradiction worth catching`
    );
  });

  // THE HEADLINE.
  await step("creating a cache on it fails before it can be refused", async () => {
    const res = await ctx.client.createCache({
      catalogId: "1", // the built-in `peaka` catalog
      schemaName: "bitable",
      tableName: storedName,
    });

    // Defensive: if Peaka ever starts allowing this, the cache is real and must
    // be cleaned up. Tracked before asserting so a failure cannot strand it.
    if (res.status === 200 && res.body && res.body.id) ctx.createdCacheIds.push(res.body.id);

    assertNoServerError(res, "createCache on a BI Table");
    assertEqual(res.status, 400, "status for createCache on a non-cacheable BI Table");

    const message = String((res.body && res.body.message) || "");
    assert(
      /cannot find table or properties/i.test(message),
      `Expected the internal name-lookup failure this endpoint currently produces for internal tables, ` +
        `got: ${message.slice(0, 200)}. If this now says TABLE_NOT_CACHEABLE, createCache has started ` +
        `reaching its cacheability check for internal tables - a FIX, and this scenario should assert the ` +
        `clean rejection the Postgres folder already gets.`
    );
    assertEqual(
      res.body.errorCode,
      null,
      `errorCode on the rejection. It is null because this is an internal lookup failure rather than a ` +
        `domain rejection, which leaves a caller nothing to branch on - see FINDINGS 28 for the other ` +
        `place this endpoint does the same thing`
    );
    console.log(`  FINDING: createCache on a BI Table -> 400 errorCode=null, "${message.slice(0, 80)}"`);
  });

  await step("delete the BI Table and confirm it is gone", async () => {
    const res = await ctx.client.deleteBiTable(storedName);
    assertStatusIn(res, [200], "deleteBiTable");
    const idx = ctx.createdBiTableNames.indexOf(storedName);
    if (idx !== -1) ctx.createdBiTableNames.splice(idx, 1);

    const list = await ctx.client.listBiTables();
    assert(
      !(list.body || []).some((t) => t.tableName === storedName),
      `'${storedName}' still appears in listBiTables() after delete`
    );
  });
}

module.exports = { runBiTableCacheability };
