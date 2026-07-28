/**
 * Unit tests for helpers/pairwiseGenerate.js.
 *
 * These are genuine UNIT tests - pure logic, zero network calls, zero
 * credentials needed - distinct in kind from jest/stripe/connector.test.js,
 * which are integration tests hitting the real Peaka Partner API. This file
 * runs instantly and needs no .env at all.
 *
 * Every check here was first verified manually (see the conversation this
 * came from) before being written as a permanent, automated test - each one
 * below directly mirrors one of those manual checks, so this can't silently
 * regress later.
 */

const { generatePairwise, allCombinations, pairsInRow } = require("../../helpers/pairwiseGenerate");

describe("allCombinations", () => {
  test("produces the full cartesian product", () => {
    const params = { A: ["a1", "a2"], B: ["b1", "b2", "b3"] };
    const result = allCombinations(params);
    expect(result).toHaveLength(2 * 3);
  });

  test("count matches the product formula for our real project's dimensions", () => {
    const params = {
      Table: ["customers", "charges", "subscriptions", "invoices", "promotion_codes", "refunds"],
      CacheSchedule: ["none", "incremental", "fullRefresh"],
      QueryFormat: ["CELL_TYPED", "SIMPLE", "COMPACT"],
      QueryMechanism: ["sql", "builder", "byId"],
    };
    expect(allCombinations(params)).toHaveLength(6 * 3 * 3 * 3); // 162
  });
});

describe("generatePairwise - core correctness", () => {
  const params = {
    Table: ["customers", "charges", "subscriptions", "invoices", "promotion_codes", "refunds"],
    CacheSchedule: ["none", "incremental", "fullRefresh"],
    QueryFormat: ["CELL_TYPED", "SIMPLE", "COMPACT"],
    QueryMechanism: ["sql", "builder", "byId"],
  };
  const names = Object.keys(params);

  test("covers every required pair - independently re-verified, not trusting internal bookkeeping", () => {
    const full = allCombinations(params);
    const pairwise = generatePairwise(params);

    // Recompute required pairs from scratch, independently of whatever the
    // generator itself thinks it needs to cover.
    const required = new Set();
    for (const combo of full) {
      for (const p of pairsInRow(combo, names)) required.add(p);
    }

    // Recompute what the generated rows ACTUALLY cover, independently.
    const covered = new Set();
    for (const row of pairwise) {
      for (const p of pairsInRow(row, names)) covered.add(p);
    }

    const missing = [...required].filter((p) => !covered.has(p));
    expect(missing).toEqual([]);
  });

  test("produces a meaningfully smaller set than the full combinatorial explosion", () => {
    const full = allCombinations(params);
    const pairwise = generatePairwise(params);
    // 162 full combinations - a real pairwise set should land well under half that.
    expect(pairwise.length).toBeLessThan(full.length / 2);
  });

  test("row count is reasonably close to what we've seen in practice (not a hard guarantee, just a sanity bound)", () => {
    const pairwise = generatePairwise(params);
    // Observed 18 rows in practice - allow some slack for future tweaks to
    // the algorithm, but a sudden jump (e.g. back toward 100+) would signal
    // something broke the reduction, not just a minor optimization change.
    expect(pairwise.length).toBeGreaterThan(5);
    expect(pairwise.length).toBeLessThan(40);
  });
});

describe("generatePairwise - reproducibility", () => {
  const params = { A: ["a1", "a2", "a3"], B: ["b1", "b2"], C: ["c1", "c2", "c3"] };

  test("same seed produces identical output every time", () => {
    const run1 = generatePairwise(params, 42);
    const run2 = generatePairwise(params, 42);
    expect(run1).toEqual(run2);
  });

  test("different seeds produce different output (this specific pair, confirmed non-flaky)", () => {
    const run1 = generatePairwise(params, 42);
    const run2 = generatePairwise(params, 99);
    expect(run1).not.toEqual(run2);
  });
});

describe("generatePairwise - edge cases", () => {
  test("single parameter (no pairs possible at all) still covers every individual value", () => {
    // Regression test: this used to return an empty array, since a single
    // parameter has zero PAIRS to cover, and the main loop only exits once
    // "uncovered pairs" is empty - which it already was from the start.
    const result = generatePairwise({ Table: ["customers", "charges", "subscriptions"] });
    const coveredValues = new Set(result.map((r) => r.Table));
    expect(coveredValues).toEqual(new Set(["customers", "charges", "subscriptions"]));
  });

  test("single parameter with a single value returns exactly one row", () => {
    const result = generatePairwise({ Table: ["customers"] });
    expect(result).toEqual([{ Table: "customers" }]);
  });
});

describe("generatePairwise - benchmark against a known published example", () => {
  test("row count is in the same range as Microsoft's own published PICT example", () => {
    // From Microsoft's own PICT documentation: 5 binary parameters
    // (Even/Factorial/Divs3/Odd/Prime), their published pairwise result was
    // 7 rows. This implementation produced 6 rows for the same input when
    // manually checked - confirming comparable quality to the real tool,
    // not just "technically covers everything but bloated."
    const params = {
      Even: [1, 0],
      Factorial: [1, 0],
      Divs3: [1, 0],
      Odd: [1, 0],
      Prime: [1, 0],
    };
    const result = generatePairwise(params);
    expect(result.length).toBeLessThanOrEqual(8); // published PICT result was 7
  });
});
