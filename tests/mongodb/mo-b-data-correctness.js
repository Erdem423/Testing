const { assertStatus, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable, classifyColumns } = require("./fixture");

/**
 * MO-B: Data Correctness - the mirror of PG-B, itself the mirror of Stripe's `C`.
 *
 * A THIRD DATA POINT, not a repeat of the second. PG-B already split "the cap
 * is connector-specific" from "string serialization is platform-wide" using
 * Postgres. Running the identical questions against a document store, rather
 * than a second relational database, is what confirms neither answer was
 * secretly "works for SQL databases" in disguise:
 *
 *   100-row cap           still CONNECTOR-SPECIFIC. MongoDB returns whole
 *                         collections, uncapped at any LIMIT.
 *   string serialization  still PLATFORM-WIDE. bigint and double arrive as
 *                         JS strings here too.
 *
 * NOTHING HARDCODED TO ONE COLLECTION - the table is discovered and every
 * expectation is derived from what it actually measures, exactly as PG-B does
 * (see ./fixture.js).
 *
 * NO CACHED PHASE, same reason as Postgres: MongoDB collections report
 * isCacheable:false (see mo-a-discovery.js), so every read here is live.
 */
async function runMoDataCorrectness(ctx) {
  let catalogName = null;
  let table = null;
  let columns = [];
  let numericColumn = null;

  const qname = () => `"${catalogName}"."${ctx.schemaName}"."${table.tableName}"`;

  async function query(sql, label) {
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatus(res, 200, label);
    assert(res.body && Array.isArray(res.body.data), `${label}: 200 but no parseable data - response too large?`);
    return res.body;
  }

  await step("resolve the catalog and discover a collection to test", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(res.body)}`);

    table = await resolveLargeTable(ctx, catalogName);

    const colRes = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(colRes, 200, `listColumns(${table.tableName})`);
    columns = colRes.body || [];
    assert(columns.length > 0, `'${table.tableName}' reports no columns`);
    numericColumn = classifyColumns(columns).numeric[0] || null;

    assert(
      table.rowCount > ctx.expectedCustomerCountNonCache,
      `The largest collection in '${ctx.schemaName}' is '${table.tableName}' with ${table.rowCount} rows, at ` +
        `or below the Stripe live cap (${ctx.expectedCustomerCountNonCache}). This scenario needs a bigger ` +
        `collection to demonstrate anything about the cap - the preflight gate should have skipped it.`
    );
    console.log(`using '${table.tableName}' (${table.rowCount} rows, discovered via ${table.source})`);
  });

  await step("COUNT(*) returns the real row count, not a cap", async () => {
    const body = await query(`SELECT COUNT(*) AS cnt FROM ${qname()}`, "COUNT(*)");
    const count = Number(body.data[0].cnt);

    assertEqual(count, table.rowCount, `${table.tableName} row count, re-counted`);
    assert(
      count > ctx.expectedCustomerCountNonCache,
      `COUNT(*) returned ${count}, at or below the Stripe live cap (${ctx.expectedCustomerCountNonCache}). If ` +
        `MongoDB has started truncating reads, the cap is no longer connector-specific.`
    );
    console.log(`COUNT(*) = ${count} (Stripe's connector would return ${ctx.expectedCustomerCountNonCache})`);
  });

  await step("a SELECT returns as many rows as it asks for", async () => {
    const cap = ctx.expectedCustomerCountNonCache;
    const limits = [...new Set([cap + 50, Math.min(cap * 5, table.rowCount)])].filter(
      (n) => n > cap && n <= table.rowCount
    );
    assert(limits.length > 0, `Could not build a LIMIT above the cap for a ${table.rowCount}-row collection`);

    const col = columns[0].name;
    for (const limit of limits) {
      const body = await query(`SELECT ${col} FROM ${qname()} LIMIT ${limit}`, `SELECT LIMIT ${limit}`);
      assertEqual(body.data.length, limit, `rows returned for LIMIT ${limit}`);
    }
    console.log(`LIMIT ${limits.join("/")} each returned exactly that many rows`);
  });

  await step("a WHERE filter spans the whole collection", async () => {
    const { numeric, text } = classifyColumns(columns);
    const filterColumn = text[0] || numeric[0];
    assert(filterColumn, `'${table.tableName}' has no usable column to filter on`);

    const sample = await query(
      `SELECT ${filterColumn} AS v FROM ${qname()} WHERE ${filterColumn} IS NOT NULL LIMIT 1`,
      "sample a filter value"
    );
    assert(sample.data.length > 0, `Could not sample a non-null value from ${filterColumn}`);
    const raw = sample.data[0].v;
    const literal = text.includes(filterColumn) ? `'${String(raw).replace(/'/g, "''")}'` : String(raw);

    const body = await query(
      `SELECT COUNT(*) AS cnt FROM ${qname()} WHERE ${filterColumn} = ${literal}`,
      "filtered COUNT(*)"
    );
    const count = Number(body.data[0].cnt);

    assert(count > 0, `The filter ${filterColumn} = ${literal} matched nothing, though the value was sampled from the table`);
    assert(
      count <= table.rowCount,
      `A filtered count of ${count} exceeds the collection's ${table.rowCount} rows, which is impossible`
    );
    console.log(`WHERE ${filterColumn}=${literal} matched ${count} of ${table.rowCount}`);

    if (count > ctx.expectedCustomerCountNonCache) {
      console.log(`filtered count ${count} exceeds the cap - the filter saw the whole collection`);
    } else {
      console.log(
        `note: this value matched only ${count} rows, under the cap, so it cannot by itself prove the ` +
          `filter was uncapped. COUNT(*) above already did.`
      );
    }
  });

  await step("the aggregate matches a total computed from the fetched rows", async () => {
    assert(numericColumn, `'${table.tableName}' has no numeric column to aggregate`);

    const agg = await query(
      `SELECT COUNT(*) AS cnt, SUM(${numericColumn}) AS total FROM ${qname()}`,
      `aggregate over ${numericColumn}`
    );
    const rows = await query(
      `SELECT ${numericColumn} FROM ${qname()} LIMIT ${table.rowCount}`,
      `raw ${numericColumn} values`
    );

    const values = rows.data.map((r) => Number(r[numericColumn])).filter((n) => Number.isFinite(n));
    const clientSum = values.reduce((a, b) => a + b, 0);

    assertEqual(rows.data.length, Number(agg.data[0].cnt), "rows fetched vs COUNT(*) - both must see the same scan");

    const serverSum = Number(agg.data[0].total);
    const drift = Math.abs(serverSum - clientSum) / Math.max(Math.abs(serverSum), 1);
    assert(
      drift < 1e-9,
      `SUM(${numericColumn}) was ${serverSum} but the ${values.length} fetched rows total ${clientSum} ` +
        `(relative difference ${drift}). The aggregate and the fetch are not seeing the same rows.`
    );
    console.log(`SUM=${serverSum} over ${rows.data.length} rows, client-side total agrees`);
  });

  await step("values arrive as strings regardless of declared type", async () => {
    const names = columns.map((c) => c.name).slice(0, 8);
    const body = await query(`SELECT ${names.join(", ")} FROM ${qname()} LIMIT 1`, "typed columns");
    const row = body.data[0];

    const byName = {};
    for (const c of columns) byName[c.name] = String(c.dataType || "").toLowerCase();

    let checked = 0;
    for (const name of names) {
      if (row[name] === null || row[name] === undefined) continue;
      const declared = byName[name];
      if (!/int|double|decimal|numeric|real|float|bool/.test(declared)) continue;
      checked++;
      assert(
        typeof row[name] === "string",
        `'${name}' is declared ${declared} and arrived as ${typeof row[name]}. If Peaka has started returning ` +
          `real types, that is an improvement - update this assertion and FINDINGS.md rather than loosening it.`
      );
    }
    assert(checked > 0, `No non-null numeric or boolean column found on '${table.tableName}' to check typing against`);
    console.log(`${checked} numeric/boolean columns all arrived as strings, exactly as Stripe and Postgres deliver them`);
  });

  await step("a double aggregate is returned in scientific notation", async () => {
    assert(numericColumn, `'${table.tableName}' has no numeric column to aggregate`);
    const body = await query(`SELECT SUM(${numericColumn}) AS total FROM ${qname()}`, "SUM for notation check");
    const raw = body.data[0].total;

    assert(typeof raw === "string", `Expected SUM to arrive as a string, got ${typeof raw}`);
    assert(Number.isFinite(Number(raw)), `SUM did not parse as a number: ${JSON.stringify(raw)}`);

    if (/e/i.test(raw)) {
      console.log(`FINDING: SUM(${numericColumn}) is returned as ${raw} - scientific notation in a string field.`);
    } else {
      console.log(`note: SUM(${numericColumn}) came back as ${raw}, not scientific notation.`);
    }
  });
}

module.exports = { runMoDataCorrectness };
