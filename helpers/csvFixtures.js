/**
 * In-memory CSV generators for Peaka Table import tests.
 *
 * Nothing here is written to disk or checked into git - every value is
 * generated in code, so the same source of truth used to build the CSV is
 * what later assertions compare the imported data against.
 *
 * Deliberately excludes JSON columns - see peakaClient.js's
 * addInternalTableColumns comment: the live API rejects dataType "JSON" for
 * both table kinds, contrary to the source doc's claim.
 */

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(header, rows) {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * A small, hand-built CSV hitting type-fidelity edge cases: decimal
 * precision, pre-1970 dates, embedded commas/quotes (CSV parser
 * correctness), Turkish/emoji characters, and an empty string.
 *
 * Returns { columns, csvString, expectedRows } - `expectedRows` are the
 * exact values a correct round-trip should produce, as JS values (not CSV
 * text), for direct comparison against a SELECT's parsed result.
 */
function buildFidelityCsv() {
  const columns = [
    { name: "id", dataType: "BIGINT", displayName: "id", isNotNull: false, isUnique: false },
    { name: "name", dataType: "VARCHAR", displayName: "name", isNotNull: false, isUnique: false },
    { name: "amount", dataType: "DECIMAL", displayName: "amount", isNotNull: false, isUnique: false },
    { name: "active", dataType: "BOOLEAN", displayName: "active", isNotNull: false, isUnique: false },
    { name: "joined", dataType: "DATE", displayName: "joined", isNotNull: false, isUnique: false },
    { name: "note", dataType: "VARCHAR", displayName: "note", isNotNull: false, isUnique: false },
  ];
  const header = columns.map((c) => c.name);
  const expectedRows = [
    { id: "1", name: "alice", amount: "10.50", active: "true", joined: "2024-01-15", note: "plain" },
    { id: "2", name: "Şişli, Beyoğlu", amount: "0.01", active: "false", joined: "1969-07-20", note: "comma + pre-1970" },
    { id: "3", name: 'say "hi"', amount: "-99.99", active: "true", joined: "2024-01-15", note: "embedded quotes" },
    { id: "4", name: "Ödemiş çğıöşü", amount: "123456789.123456", active: "false", joined: "2024-01-15", note: "turkish + decimal precision" },
    { id: "5", name: "", amount: "0.00", active: "true", joined: "2024-01-15", note: "empty name vs NULL" },
    { id: "6", name: "🎉 emoji", amount: "0.10", active: "false", joined: "2024-01-15", note: "4-byte utf8" },
  ];
  return { columns, csvString: rowsToCsv(header, expectedRows), expectedRows };
}

/**
 * Generates `n` rows with a known category distribution (e.g.
 * { click: 300, view: 150, purchase: 50 }), for count/GROUP BY assertions.
 * Deterministic - no Math.random - so the same call always produces the
 * same rows, and `amount` is a formula (not random), so its expected SUM is
 * computable without re-reading the CSV.
 */
function buildVolumeCsv(n, distribution) {
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);
  if (total !== n) {
    throw new Error(`buildVolumeCsv: distribution sums to ${total}, expected ${n}`);
  }

  const categories = [];
  for (const [cat, count] of Object.entries(distribution)) {
    for (let i = 0; i < count; i++) categories.push(cat);
  }

  // Deterministic shuffle (LCG, fixed seed) so rows aren't grouped by
  // category in file order - a real distribution, not a sorted one.
  let seed = 42;
  const nextRand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = categories.length - 1; i > 0; i--) {
    const j = Math.floor(nextRand() * (i + 1));
    [categories[i], categories[j]] = [categories[j], categories[i]];
  }

  const columns = [
    { name: "event_id", dataType: "BIGINT", displayName: "event_id", isNotNull: false, isUnique: false },
    { name: "event_type", dataType: "VARCHAR", displayName: "event_type", isNotNull: false, isUnique: false },
    { name: "amount", dataType: "DECIMAL", displayName: "amount", isNotNull: false, isUnique: false },
  ];
  const header = columns.map((c) => c.name);
  const rows = categories.map((event_type, i) => ({
    event_id: String(i + 1),
    event_type,
    amount: (((i * 37) % 1000) / 100).toFixed(2),
  }));
  const expectedTotal = rows.reduce((sum, r) => sum + Number(r.amount), 0);

  return {
    columns,
    csvString: rowsToCsv(header, rows),
    expectedRows: rows,
    expectedDistribution: distribution,
    expectedTotal,
  };
}

module.exports = { buildFidelityCsv, buildVolumeCsv, csvEscape, rowsToCsv };
