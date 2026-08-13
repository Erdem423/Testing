#!/usr/bin/env node
/**
 * Checks the `refs` metadata on scenarios in tests/<connector>/meta.js.
 *
 * WHY THIS EXISTS. Each scenario records which written rule made it necessary
 * - a Peaka docs page, a scenario in the instructor's spec, or a FINDINGS.md
 * entry. The idea is borrowed from the Open Banking conformance suite, where
 * every test case carries a refURI pointing at the spec clause it enforces.
 * Keeping those links in prose means nothing can verify them; keeping them in
 * `refs` means this script can.
 *
 * It answers two questions that were previously answered by hand:
 *   - "which of the spec's scenarios do we actually cover?"
 *   - "does every finding we cite actually exist?"
 *
 * VALIDATION failures exit non-zero. REPORTS are informational: a finding that
 * no scenario references is usually legitimate (plenty are Stripe- or
 * Postgres-only), and an uncovered spec scenario is often one that cannot be
 * built at all - see FINDINGS 9 and 11.
 *
 * Usage: npm run check:refs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TESTS_DIR = path.join(ROOT, "tests");
const FINDINGS = path.join(ROOT, "FINDINGS.md");

const KINDS = ["docs", "spec", "finding"];
const SPEC_ID = /^(PT|BT|CMP)-\d+b?$/;
const DOCS_HOST = "https://docs.peaka.com";

const errors = [];
const scenarios = [];

/** Every `## <n>.` heading number in FINDINGS.md. */
function findingHeadings() {
  if (!fs.existsSync(FINDINGS)) {
    errors.push(`FINDINGS.md not found at ${FINDINGS}`);
    return new Set();
  }
  const nums = new Set();
  for (const line of fs.readFileSync(FINDINGS, "utf8").split("\n")) {
    const m = line.match(/^##\s+(\d+)\./);
    if (m) {
      const n = Number(m[1]);
      if (nums.has(n)) errors.push(`FINDINGS.md has TWO headings numbered ${n}`);
      nums.add(n);
    }
  }
  return nums;
}

/**
 * FINDINGS.md carries the same numbers twice: once as `## <n>.` headings and
 * once as `| <n> |` rows in the summary table at the top. They are maintained
 * by hand and have drifted before, so compare them. Reported rather than
 * failed - some summary rows are deliberately unnumbered ("—") for findings
 * that never got their own section.
 */
function summaryRowNumbers() {
  if (!fs.existsSync(FINDINGS)) return new Set();
  const nums = new Set();
  for (const line of fs.readFileSync(FINDINGS, "utf8").split("\n")) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (m) nums.add(Number(m[1]));
  }
  return nums;
}

function loadScenarios() {
  for (const entry of fs.readdirSync(TESTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(TESTS_DIR, entry.name, "meta.js");
    if (!fs.existsSync(metaPath)) continue;
    let meta;
    try {
      meta = require(metaPath);
    } catch (err) {
      errors.push(`tests/${entry.name}/meta.js failed to load: ${err.message}`);
      continue;
    }
    for (const s of meta.scenarios || []) scenarios.push({ folder: entry.name, ...s });
  }
}

function validate(known) {
  for (const s of scenarios) {
    if (!s.refs) continue; // refs are optional - only peaka-tables carries them today
    if (!Array.isArray(s.refs)) {
      errors.push(`[${s.folder}] "${s.name}": refs must be an array`);
      continue;
    }
    s.refs.forEach((ref, i) => {
      const where = `[${s.folder}] "${s.name}" refs[${i}]`;
      if (!ref || !KINDS.includes(ref.kind)) {
        errors.push(`${where}: kind must be one of ${KINDS.join(", ")} - got ${JSON.stringify(ref && ref.kind)}`);
        return;
      }
      if (ref.kind === "docs") {
        if (typeof ref.url !== "string" || !ref.url.startsWith(DOCS_HOST)) {
          errors.push(`${where}: docs refs need a url under ${DOCS_HOST} - got ${JSON.stringify(ref.url)}`);
        }
      } else if (ref.kind === "spec") {
        if (typeof ref.id !== "string" || !SPEC_ID.test(ref.id)) {
          errors.push(`${where}: spec id must look like PT-12 / BT-06 / CMP-01 - got ${JSON.stringify(ref.id)}`);
        }
      } else if (ref.kind === "finding") {
        if (typeof ref.id !== "number") {
          errors.push(`${where}: finding id must be a number - got ${JSON.stringify(ref.id)}`);
        } else if (!known.has(ref.id)) {
          errors.push(
            `${where}: cites FINDINGS ${ref.id}, but FINDINGS.md has no "## ${ref.id}." heading. ` +
              `Either the finding was renumbered or the ref is stale.`
          );
        }
      }
    });
  }
}

function report(known) {
  const withRefs = scenarios.filter((s) => s.refs);
  const refsOf = (kind) => withRefs.flatMap((s) => s.refs.filter((r) => r.kind === kind));

  console.log(`Scanned ${scenarios.length} scenarios across tests/*/meta.js; ${withRefs.length} carry refs.\n`);

  // --- spec coverage -------------------------------------------------------
  const specCovered = new Map();
  for (const s of withRefs) {
    for (const r of s.refs.filter((x) => x.kind === "spec")) {
      if (!specCovered.has(r.id)) specCovered.set(r.id, []);
      specCovered.get(r.id).push(s.name);
    }
  }
  const sortedSpec = [...specCovered.keys()].sort();
  console.log(`SPEC COVERAGE - ${sortedSpec.length} scenario ids claimed by a test:`);
  for (const id of sortedSpec) {
    console.log(`  ${id.padEnd(8)} ${specCovered.get(id).join(" / ")}`);
  }

  // --- findings ------------------------------------------------------------
  const cited = new Set(refsOf("finding").map((r) => r.id));
  const orphans = [...known].filter((n) => !cited.has(n)).sort((a, b) => a - b);
  console.log(`\nFINDINGS - ${cited.size} of ${known.size} headings are cited by at least one scenario.`);
  if (orphans.length) {
    console.log(`  not referenced by any scenario in this folder set: ${orphans.join(", ")}`);
    console.log("  (expected for Stripe- and Postgres-only findings - informational, not a failure)");
  }

  // --- docs ----------------------------------------------------------------
  const urls = [...new Set(refsOf("docs").map((r) => r.url))].sort();
  console.log(`\nDOCS - ${urls.length} distinct pages referenced:`);
  for (const u of urls) console.log(`  ${u}`);

  // --- FINDINGS.md internal consistency ------------------------------------
  const rows = summaryRowNumbers();
  const rowsOnly = [...rows].filter((n) => !known.has(n)).sort((a, b) => a - b);
  const headingsOnly = [...known].filter((n) => !rows.has(n)).sort((a, b) => a - b);
  console.log(`\nFINDINGS.md CONSISTENCY - ${known.size} headings vs ${rows.size} numbered summary rows:`);
  if (!rowsOnly.length && !headingsOnly.length) {
    console.log("  headings and summary rows agree");
  } else {
    if (rowsOnly.length) console.log(`  summary row with NO matching heading: ${rowsOnly.join(", ")}`);
    if (headingsOnly.length) console.log(`  heading with NO matching summary row: ${headingsOnly.join(", ")}`);
    console.log("  (informational - these two lists are maintained by hand and have drifted before)");
  }
}

function main() {
  const known = findingHeadings();
  loadScenarios();
  validate(known);
  report(known);

  if (errors.length) {
    console.error(`\n${errors.length} PROBLEM(S):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log("\nAll refs valid.");
}

main();
