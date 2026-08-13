#!/usr/bin/env node
/**
 * meta.js step-name drift detector.
 *
 * The `steps` arrays in tests/<folder>/meta.js are display metadata for the
 * dashboard. A name that does not match a real step("...") call shows as a
 * step that is permanently "pending" - it is waiting for an event that will
 * never arrive under that name. Nothing fails; the display is just quietly
 * wrong, which is why this needs a checker rather than a test.
 *
 * These have drifted stale repeatedly - see the header of
 * tests/peaka-tables/meta.js.
 *
 * DISCOVERS FOLDERS rather than hardcoding them. An earlier version listed
 * ["stripe", "races"], so when the postgres folder was added it was silently
 * skipped - the checker had exactly the blind spot it exists to prevent.
 *
 * Usage: npm run check:meta
 */
const fs = require("fs");
const path = require("path");

const TESTS = path.join(__dirname, "..", "tests");

let bad = false;
const folders = fs
  .readdirSync(TESTS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(TESTS, e.name, "meta.js")))
  .map((e) => e.name);

for (const folder of folders) {
  const dir = path.join(TESTS, folder);
  const meta = require(path.join(dir, "meta.js"));

  const declared = new Set();
  for (const s of meta.scenarios || []) for (const st of s.steps || []) declared.add(st);

  const actual = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js") || f === "meta.js" || f === "config.js" || f === "fixture.js") continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/\bstep\(\s*(["`])((?:\\.|(?!\1)[^\\])*)\1/g)) actual.add(m[2]);
  }

  // TEMPLATE-LITERAL STEP NAMES NEED HANDLING IN BOTH DIRECTIONS, and an
  // earlier version only did one. Steps like
  //
  //   step(`list columns for '${tableName}'`)      // loops over 4 tables
  //   step(`${PARALLEL_QUERY_COUNT} parallel queries degrade gracefully`)
  //
  // are written once in code but emit several concrete names at runtime, which
  // meta.js correctly lists in expanded form. Skipping them only on the
  // code -> meta side made every one of those expansions look "stale" going
  // meta -> code: 5 false positives across stripe and races the moment this
  // ran on folders other than peaka-tables.
  //
  // So each template becomes a pattern, and a declared name counts as matched
  // if it satisfies any of them.
  const literals = [...actual].filter((s) => !s.includes("${"));
  const patterns = [...actual]
    .filter((s) => s.includes("${"))
    .map((s) => new RegExp("^" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$\\\{[^}]*\\\}/g, ".+") + "$"));

  const matchesTemplate = (name) => patterns.some((re) => re.test(name));

  const missing = literals.filter((s) => !declared.has(s));
  const stale = [...declared].filter((s) => !actual.has(s) && !matchesTemplate(s));

  console.log(`\n=== ${folder} (${declared.size} declared, ${actual.size} found in code) ===`);
  console.log("  in code but NOT in meta:", missing.length ? missing : "none");
  console.log("  in meta but NOT in code:", stale.length ? stale : "none");
  if (missing.length || stale.length) bad = true;
}

console.log(bad ? "\nSTEP DRIFT DETECTED" : "\nNo step drift.");
process.exit(bad ? 1 : 0);
