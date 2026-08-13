#!/usr/bin/env node
/**
 * Scenario-name integrity: three-way sync, and comma safety.
 *
 * Every scenario's name lives in THREE places that must match byte for byte:
 *
 *   tests/<folder>/meta.js  `name`
 *   jest/<folder>/*.test.js  the test()/gatedTest()/gateFor() title
 *   jest/<folder>/*.test.js  the withScenario("...") argument
 *
 * WHY IT MATTERS. The dashboard's "Run Selected" button sends the meta.js name
 * and matches it against Jest test titles EXACTLY (server.js builds
 * `^(name|name)$`). Any drift and the button silently runs nothing - no error,
 * no failure, just an empty run.
 *
 * NO COMMAS IN SCENARIO NAMES. server.js splits that same parameter on commas
 * before matching, so a name containing one is torn into fragments that match
 * nothing. This is not hypothetical: the scenario later renamed to "The sample
 * endpoint returns a type-aware template with example rows" was originally
 * "PT-13: sample endpoint returns a canned template, not real data" and
 * matched ZERO tests through that button.
 *
 * Names are compared as SETS per folder rather than per file, because some
 * files declare several scenarios (jest/stripe/connector.test.js holds B, C
 * and F).
 *
 * Usage: npm run check:names
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TESTS = path.join(ROOT, "tests");
const JEST = path.join(ROOT, "jest");

let bad = false;

/** Replicates server.js's "Run Selected" parameter handling exactly. */
function survivesRunSelected(names) {
  const param = names.join(",");
  const parsed = param.split(",").map((n) => n.trim()).filter(Boolean);
  const escaped = parsed.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^(${escaped.join("|")})$`);
  return names.filter((n) => re.test(n));
}

const folders = fs
  .readdirSync(TESTS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(TESTS, e.name, "meta.js")))
  .map((e) => e.name);

for (const folder of folders) {
  const meta = require(path.join(TESTS, folder, "meta.js"));
  const metaNames = (meta.scenarios || []).map((s) => s.name);

  const jestDir = path.join(JEST, folder);
  if (!fs.existsSync(jestDir)) {
    console.log(`\n=== ${folder} ===\n  no jest/${folder} directory - skipped`);
    continue;
  }

  const titles = new Set();
  const scenarioArgs = new Set();
  for (const f of fs.readdirSync(jestDir)) {
    if (!f.endsWith(".test.js")) continue;
    const src = fs.readFileSync(path.join(jestDir, f), "utf8");
    // test( / test.concurrent( / gatedTest( / gateFor( - all take the name first.
    for (const m of src.matchAll(/\b(?:gatedTest|gateFor|test(?:\.concurrent)?)\(\s*\r?\n?\s*"([^"]+)"/g)) {
      titles.add(m[1]);
    }
    for (const m of src.matchAll(/withScenario\(\s*"([^"]+)"/g)) scenarioArgs.add(m[1]);
  }

  const missingTitle = metaNames.filter((n) => !titles.has(n));
  const missingScenario = metaNames.filter((n) => !scenarioArgs.has(n));
  const orphanTitle = [...titles].filter((n) => !metaNames.includes(n));
  const withComma = metaNames.filter((n) => n.includes(","));
  const survived = survivesRunSelected(metaNames);
  const lost = metaNames.filter((n) => !survived.includes(n));

  console.log(`\n=== ${folder} (${metaNames.length} scenarios) ===`);
  const problems = [];
  if (missingTitle.length) problems.push(["in meta.js but no matching test title", missingTitle]);
  if (missingScenario.length) problems.push(["in meta.js but no matching withScenario()", missingScenario]);
  if (orphanTitle.length) problems.push(["test title with no meta.js entry", orphanTitle]);
  if (withComma.length) problems.push(["CONTAINS A COMMA - breaks Run Selected", withComma]);
  if (lost.length) problems.push(["does not survive Run Selected round trip", lost]);

  if (problems.length === 0) {
    console.log(`  three-way sync OK, all ${metaNames.length} survive Run Selected`);
  } else {
    bad = true;
    for (const [label, list] of problems) {
      console.log(`  ${label}:`);
      for (const n of list) console.log(`    - ${n}`);
    }
  }
}

console.log(bad ? "\nNAME PROBLEMS DETECTED" : "\nAll scenario names consistent.");
process.exit(bad ? 1 : 0);
