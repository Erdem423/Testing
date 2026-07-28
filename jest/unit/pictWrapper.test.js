/**
 * Unit tests for helpers/pictWrapper.js - the wrapper around the ACTUAL
 * Microsoft PICT binary (tools/pict/pict.exe on Windows, tools/pict/pict-linux
 * on Linux/CI), not a reimplementation.
 *
 * These tests actually invoke the real binary for this platform - no
 * mocking, no fakes. If the binary is missing or broken, these tests fail
 * for real, which is the point.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  generateWithRealPict,
  buildModelFileContent,
  parsePictOutput,
  pictBinaryPath,
} = require("../../helpers/pictWrapper");

describe("buildModelFileContent", () => {
  test("produces PICT's expected model file syntax", () => {
    const content = buildModelFileContent({
      Table: ["customers", "charges"],
      Format: ["SIMPLE", "COMPACT"],
    });
    expect(content).toBe("Table: customers, charges\nFormat: SIMPLE, COMPACT");
  });
});

describe("parsePictOutput", () => {
  test("parses real PICT tab-separated output correctly", () => {
    const raw = "Table\tFormat\ncustomers\tSIMPLE\ncharges\tCOMPACT";
    const rows = parsePictOutput(raw);
    expect(rows).toEqual([
      { Table: "customers", Format: "SIMPLE" },
      { Table: "charges", Format: "COMPACT" },
    ]);
  });

  test("returns an empty array for output with only a header row", () => {
    expect(parsePictOutput("Table\tFormat")).toEqual([]);
  });
});

describe("pictBinaryPath", () => {
  test("points at an actual file that exists on disk for this platform", () => {
    const binaryPath = pictBinaryPath();
    expect(fs.existsSync(binaryPath)).toBe(true);
  });
});

describe("generateWithRealPict - actually invokes the real binary", () => {
  const params = {
    Table: ["customers", "charges", "subscriptions", "invoices", "promotion_codes", "refunds"],
    CacheSchedule: ["none", "incremental", "fullRefresh"],
    QueryFormat: ["CELL_TYPED", "SIMPLE", "COMPACT"],
    QueryMechanism: ["sql", "builder", "byId"],
  };
  const names = Object.keys(params);

  function pairsInRow(row) {
    const pairs = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = `${names[i]}=${row[names[i]]}`;
        const b = `${names[j]}=${row[names[j]]}`;
        pairs.push(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
    }
    return pairs;
  }

  test("real binary's output covers every required pair - independently re-verified", () => {
    const rows = generateWithRealPict(params);

    // Recompute required pairs from scratch, independent of the binary.
    const required = new Set();
    const allValues = names.map((n) => params[n]);
    function cartesian(idx, acc) {
      if (idx === names.length) {
        for (let i = 0; i < names.length; i++) {
          for (let j = i + 1; j < names.length; j++) {
            const a = `${names[i]}=${acc[i]}`;
            const b = `${names[j]}=${acc[j]}`;
            required.add(a < b ? `${a}|${b}` : `${b}|${a}`);
          }
        }
        return;
      }
      for (const v of allValues[idx]) cartesian(idx + 1, [...acc, v]);
    }
    cartesian(0, []);

    const covered = new Set();
    for (const row of rows) {
      for (const p of pairsInRow(row)) covered.add(p);
    }

    const missing = [...required].filter((p) => !covered.has(p));
    expect(missing).toEqual([]);
  });

  test("real binary produces a meaningfully smaller set than full combinatorial (162)", () => {
    const rows = generateWithRealPict(params);
    expect(rows.length).toBeLessThan(162 / 2);
  });

  test("cleans up its temp model file after running (no leftovers)", () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("pict-model-"));
    generateWithRealPict({ A: ["a1", "a2"], B: ["b1", "b2"] });
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("pict-model-"));
    expect(after.length).toBe(before.length);
  });
});
