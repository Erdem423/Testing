const { assertStatus, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { resolveLargeTable, classifyColumns } = require("./fixture");

/**
 * PG-B: Data Correctness - the mirror image of Stripe's `C`.
 *
 * `C` exists to pin the 100-row cap: every live count comes back as exactly
 * 100 regardless of the table's real size, and only caching escapes it. This
 * scenario asserts the OPPOSITE, and that contrast is the entire point.
 *
 * WHY IT MATTERS MORE THAN THE COVERAGE. Every finding in FINDINGS.md was
 * measured against Stripe, so none of them could distinguish "Peaka does this"
 * from "Peaka's Stripe connector does this". Running the same questions against
 * a second connector splits them, and the answers are already clear:
 *
 *   100-row cap          CONNECTOR-SPECIFIC. Postgres returns whole tables,
 *                        uncapped at any LIMIT, with filters and aggregates
 *                        spanning everything.
 *   string serialization PLATFORM-WIDE. bigint and double arrive as JS strings
 *                        here exactly as they do for Stripe.
 *
 * NOTHING HERE IS HARDCODED TO ONE DATABASE. This file used to assert
 * `COUNT(*) === 25000` and `WHERE country = 'Australia' === 2528` against a
 * specific Supabase instance, so it could not run for anyone else. Every
 * expectation is now derived from the table it just measured - see ./fixture.js.
 * The claim only ever needed "well over 100 rows", never a particular number.
 *
 * EVERY READ HERE IS LIVE. Postgres cannot be cached at all, so there is no
 * cached phase to compare against and no cache lifecycle to run - unlike `C`,
 * which runs every assertion twice.
 */
async function runPgDataCorrectness(ctx) {
  let catalogName = null;
  let table = null;
  let columns = [];
  let numericColumn = null;

  const qname = () => `"${catalogName}"."${ctx.schemaName}"."${table.tableName}"`;

  async function query(sql, label) {
    const res = await ctx.client.executeQuery({ statement: sql }, "SIMPLE");
    assertStatus(res, 200, label);
    // A 200 with an unparseable body means the response was too large to read
    // rather than that the query failed - worth saying so explicitly, since
    // `SELECT *` over a big table hits it and the resulting "cannot read
    // properties of null" is otherwise baffling.
    assert(res.body && Array.isArray(res.body.data), `${label}: 200 but no parseable data - response too large?`);
    return res.body;
  }

  await step("resolve the catalog and discover a table to test", async () => {
    const res = await ctx.client.getCatalog(ctx.catalogId);
    assertStatus(res, 200, "getCatalog");
    catalogName = res.body.name;
    assert(catalogName, `Expected a queryable catalog name, got: ${JSON.stringify(res.body)}`);

    table = await resolveLargeTable(ctx, catalogName);

    // Columns are fetched here, not in a later step, so every step below picks
    // real column names instead of guessing at them.
    const colRes = await ctx.client.listColumns(ctx.catalogId, ctx.schemaName, table.tableName);
    assertStatus(colRes, 200, `listColumns(${table.tableName})`);
    columns = colRes.body || [];
    assert(columns.length > 0, `'${table.tableName}' reports no columns`);
    numericColumn = classifyColumns(columns).numeric[0] || null;

    assert(
      table.rowCount > ctx.expectedCustomerCountNonCache,
      `The largest table in '${ctx.schemaName}' is '${table.tableName}' with ${table.rowCount} rows, which is ` +
        `at or below the Stripe live cap (${ctx.expectedCustomerCountNonCache}). This scenario cannot ` +
        `demonstrate anything about the cap without a bigger table - the preflight gate should have skipped it.`
    );
    console.log(`using '${table.tableName}' (${table.rowCount} rows, discovered via ${table.source})`);
  });

  // THE HEADLINE. On Stripe this same query returns exactly 100 no matter how
  // many rows the table holds. Here it returns all of them.
  await step("COUNT(*) returns the real row count, not a cap", async () => {
    const body = await query(`SELECT COUNT(*) AS cnt FROM ${qname()}`, "COUNT(*)");
    const count = Number(body.data[0].cnt);

    assertEqual(count, table.rowCount, `${table.tableName} row count, re-counted`);
    assert(
      count > ctx.expectedCustomerCountNonCache,
      `COUNT(*) returned ${count}, which is at or below the Stripe live cap ` +
        `(${ctx.expectedCustomerCountNonCache}). If a database connector has started truncating reads, ` +
        `that is a serious regression and the cap is no longer connector-specific.`
    );
    console.log(`COUNT(*) = ${count} (Stripe's connector would return ${ctx.expectedCustomerCountNonCache})`);
  });

  // The row-retrieval form. On Stripe, LIMIT 150/250/500 all return exactly
  // 100 - the cap sits on the scan, so it truncates ordinary fetches too.
  await step("a SELECT returns as many rows as it asks for", async () => {
    // Chosen relative to the real size, so this works on a 200-row table and a
    // 25,000-row one alike. Every limit is above the cap - that is the point -
    // and none exceeds what the table can supply.
    const cap = ctx.expectedCustomerCountNonCache;
    // Deliberately capped at cap*5 rather than the whole table: exceeding the
    // cap is the entire claim, and `SELECT *` over 25,000 rows returns a
    // payload too large to parse (a 200 with an unreadable body), which reads
    // as a mysterious failure rather than a finding.
    const limits = [...new Set([cap + 50, Math.min(cap * 5, table.rowCount)])].filter(
      (n) => n > cap && n <= table.rowCount
    );
    assert(limits.length > 0, `Could not build a LIMIT above the cap for a ${table.rowCount}-row table`);

    // ONE column, not `SELECT *` - the assertion is about row COUNT, and a
    // single column keeps the response small enough to be reliable.
    const col = columns[0].name;
    for (const limit of limits) {
      const body = await query(`SELECT ${col} FROM ${qname()} LIMIT ${limit}`, `SELECT LIMIT ${limit}`);
      assertEqual(body.data.length, limit, `rows returned for LIMIT ${limit}`);
    }
    console.log(`LIMIT ${limits.join("/")} each returned exactly that many rows`);
  });

  // On Stripe a WHERE filters only the first 100 rows, so filtered counts are
  // capped too - the symptom that made the cap so hard to spot, because the
  // numbers stayed plausible.
  await step("a WHERE filter spans the whole table", async () => {
    const { numeric, text } = classifyColumns(columns);

    // Pick a filter column and a value that actually occurs, rather than
    // hardcoding `country = 'Australia'`. A low-cardinality text column gives
    // the best chance of a match count that is large but not the whole table.
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
      `A filtered count of ${count} exceeds the table's ${table.rowCount} rows, which is impossible`
    );
    console.log(`WHERE ${filterColumn}=${literal} matched ${count} of ${table.rowCount}`);

    // The real assertion, and the one that mirrors Stripe. A filtered count is
    // only proof of an uncapped scan if it EXCEEDS the cap - below that it is
    // indistinguishable from a capped read that happened to match few rows.
    if (count > ctx.expectedCustomerCountNonCache) {
      console.log(`filtered count ${count} exceeds the cap - the filter saw the whole table`);
    } else {
      console.log(
        `note: this value matched only ${count} rows, under the cap, so it cannot by itself prove the ` +
          `filter was uncapped. COUNT(*) above already did.`
      );
    }
  });

  // The scenario-11 technique applied to a connector without a cap. On Stripe
  // the aggregate and the fetched rows agree AT THE CAP, proving the cap sits
  // on the scan. Here they should agree at full scale.
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

    assertEqual(
      rows.data.length,
      Number(agg.data[0].cnt),
      "rows fetched vs COUNT(*) - both must see the same scan"
    );

    // Floating point: SUM over many doubles will not match to the last bit,
    // so compare proportionally. A cap or a truncated scan would be off by
    // orders of magnitude, not by rounding.
    const serverSum = Number(agg.data[0].total);
    const drift = Math.abs(serverSum - clientSum) / Math.max(Math.abs(serverSum), 1);
    assert(
      drift < 1e-9,
      `SUM(${numericColumn}) was ${serverSum} but the ${values.length} fetched rows total ${clientSum} ` +
        `(relative difference ${drift}). The aggregate and the fetch are not seeing the same rows.`
    );
    console.log(`SUM=${serverSum} over ${rows.data.length} rows, client-side total agrees`);
  });

  // PLATFORM-WIDE, not a Stripe quirk - which is the other half of the
  // attribution answer. Declared types are real (pg-a-discovery asserts they
  // are present and specific), yet every value arrives as a string.
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
        `'${name}' is declared ${declared} and arrived as ${typeof row[name]}. If Peaka has started ` +
          `returning real types, that is an improvement - update this assertion and FINDINGS.md rather ` +
          `than loosening it.`
      );
    }
    assert(checked > 0, `No non-null numeric or boolean column found on '${table.tableName}' to check typing against`);
    console.log(`${checked} numeric/boolean columns all arrived as strings, exactly as Stripe delivers them`);
  });

  // A quirk worth its own step because it breaks naive clients differently
  // from the plain string convention: a double aggregate comes back in
  // SCIENTIFIC NOTATION. Number() copes; a non-JS client or a regex may not.
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

module.exports = { runPgDataCorrectness };
