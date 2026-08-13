const fs = require("fs");
const path = require("path");
const { SKIP_MARKER } = require("../../helpers/preflight");
const { SIDECAR_DIR } = require("../../helpers/serverError");

/**
 * Makes a partial run impossible to mistake for a full one - and, since the
 * 5xx work, makes a run that quietly swallowed a server error impossible to
 * mistake for a clean one.
 *
 * This repo held for a long time that missing data must FAIL rather than skip,
 * because a silent skip once let a run report green while verifying almost
 * nothing. Scenarios now skip instead (so the suite is portable to accounts
 * that aren't seeded), which is only defensible if not-running is as loud as
 * failing. That is this reporter's first job:
 *
 *   1. A banner naming every scenario that did not execute, and why.
 *   2. test-results/coverage.json - the same thing machine-readable, so it
 *      outlives the terminal scrollback.
 *   3. A NON-ZERO EXIT CODE, so CI and `npm test && ...` cannot treat a
 *      partial run as a pass. This is the one that works without a human
 *      reading anything. Opt out with ALLOW_INCOMPLETE=true.
 *
 * Its second job is 5xx reporting. doc2.txt rule 6 says a 5xx is always a bug,
 * never an expected outcome. Two steps nonetheless PASS while receiving one
 * (see helpers/serverError.js for why keeping them green is the right call), so
 * without a banner those 500s would be invisible. Server errors get their OWN
 * banner rather than sharing the incomplete one, because "these scenarios
 * verified NOTHING" is false for a scenario that verified everything and
 * passed - and each line carries the scenario's final status, so "passed with a
 * tolerated 500" stays distinguishable from "failed, and also saw a 500".
 *
 * Server errors do NOT change the exit code by default: a warning that fails
 * the run is just a failure with extra steps. FAIL_ON_SERVER_ERROR=true opts in
 * for CI that wants rule 6 enforced literally.
 *
 * jest-junit already writes <skipped/> entries into the JUnit XML, so CI
 * dashboards that parse it surface those too, for free.
 */

/**
 * Reads the per-process JSONL records helpers/serverError.js appends.
 *
 * A file rather than an in-memory collector because Jest runs test files in
 * separate worker PROCESSES - this reporter lives in the host and cannot see
 * their memory. Tolerates a missing directory: no directory simply means no
 * server errors, which is the normal case.
 */
function readServerErrorRecords() {
  let files;
  try {
    files = fs.readdirSync(SIDECAR_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch (_) {
    return [];
  }
  const records = [];
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(SIDECAR_DIR, file), "utf8");
    } catch (_) {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (_) {
        // A torn final line from a killed worker - skip it rather than
        // failing the whole report.
      }
    }
  }
  return records;
}
class IncompleteRunReporter {
  constructor(globalConfig) {
    this._globalConfig = globalConfig;
    this._error = undefined;
  }

  /**
   * Jest's documented hook for a reporter to fail the run: if this returns an
   * error, the process exits non-zero. Used instead of setting
   * process.exitCode directly, which Jest's own exit handling may overwrite.
   */
  getLastError() {
    return this._error;
  }

  onRunComplete(_contexts, results) {
    const skipped = [];
    const executed = [];

    for (const suite of results.testResults) {
      for (const t of suite.testResults) {
        // Jest reports a skipped test as "pending".
        if (t.status === "pending" || t.status === "skipped") {
          const marker = t.fullName.indexOf(SKIP_MARKER);
          const name = marker === -1 ? t.fullName : t.fullName.slice(0, marker).trim();
          const reason =
            marker === -1
              ? "no reason recorded (skipped outside the preflight gate)"
              : t.fullName.slice(marker + SKIP_MARKER.length).replace(/\]$/, "");
          skipped.push({ name, reason });
        } else {
          executed.push({ name: t.fullName, status: t.status });
        }
      }
    }

    // Join each 5xx onto the final status of the scenario that saw it, so the
    // banner never conflates "passed with a tolerated 500" with "failed, and
    // also saw a 500".
    const statusByScenario = new Map(executed.map((e) => [e.name, e.status]));
    const serverErrors = readServerErrorRecords().map((r) => ({
      ...r,
      scenarioStatus: statusByScenario.get(r.scenario) || "unknown",
    }));
    const toleratedCount = serverErrors.filter((r) => r.tolerated).length;
    const perScenarioCounts = new Map();
    for (const r of serverErrors) {
      perScenarioCounts.set(r.scenario, (perScenarioCounts.get(r.scenario) || 0) + 1);
    }

    const manifest = {
      completedAt: new Date().toISOString(),
      total: executed.length + skipped.length,
      executed: executed.length,
      skipped: skipped.length,
      complete: skipped.length === 0,
      // ADDITIVE ONLY - `complete` keeps its original meaning so anything
      // already reading this file still works. `clean` is the field a human or
      // CI should actually read.
      serverErrors: serverErrors.length,
      serverErrorsTolerated: toleratedCount,
      clean: skipped.length === 0 && serverErrors.length === 0,
      scenarios: [
        ...executed.map((e) => ({
          name: e.name,
          ran: true,
          status: e.status,
          serverErrors: perScenarioCounts.get(e.name) || 0,
        })),
        ...skipped.map((s) => ({ name: s.name, ran: false, reason: s.reason })),
      ],
      serverErrorDetail: serverErrors,
    };

    const outPath = path.join(__dirname, "..", "..", "test-results", "coverage.json");
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.error(`Could not write ${outPath}: ${err.message}`);
    }

    const failOnServerError = process.env.FAIL_ON_SERVER_ERROR === "true";
    const bar = "═".repeat(72);

    // SERVER ERRORS FIRST, so the incomplete banner keeps the last word - it
    // owns the exit-code line.
    if (serverErrors.length > 0) {
      console.log("");
      console.log(bar);
      console.log(
        `  SERVER ERRORS — ${serverErrors.length} 5xx response${serverErrors.length === 1 ? "" : "s"} ` +
          `across ${manifest.total} scenarios`
      );
      console.log(bar);
      for (const r of serverErrors) {
        console.log(`  ${r.scenario || "(unattributed)"}   [${String(r.scenarioStatus).toUpperCase()}]`);
        if (r.step) console.log(`    ${r.step}`);
        console.log(`      ${r.status}  ${r.label || ""}${r.tolerated ? "" : "   <- FAILED THE STEP"}`);
        if (r.reason) console.log(`      ${r.reason}`);
        if (r.context) console.log(`      (${r.context})`);
      }
      console.log("");
      console.log("  doc2.txt rule 6: a 5xx is always a bug, never an expected outcome.");
      console.log(`  Tolerated: ${toleratedCount}  ·  Failed on: ${serverErrors.length - toleratedCount}`);
      console.log(`  Details: test-results/coverage.json`);
      if (failOnServerError) {
        console.log("  FAIL_ON_SERVER_ERROR=true - failing the run.");
      } else {
        console.log("  Exit code unaffected. Set FAIL_ON_SERVER_ERROR=true to fail on these.");
      }
      console.log(bar);
      console.log("");
    }

    const messages = [];
    if (serverErrors.length > 0 && failOnServerError) {
      messages.push(
        `${serverErrors.length} server error(s) observed (${toleratedCount} tolerated). ` +
          `FAIL_ON_SERVER_ERROR=true is set.`
      );
    }

    if (skipped.length === 0) {
      // getLastError() returns ONE error, so any messages accumulated above
      // still have to be surfaced even when nothing was skipped.
      if (messages.length > 0) this._error = new Error(messages.join(" "));
      return;
    }

    const allowed = process.env.ALLOW_INCOMPLETE === "true";
    const width = skipped.reduce((w, s) => Math.max(w, s.name.length), 0);

    console.log("");
    console.log(bar);
    console.log(`  INCOMPLETE RUN — ${skipped.length} of ${manifest.total} scenarios did not execute`);
    console.log(bar);
    for (const s of skipped) {
      console.log(`  ${s.name.padEnd(width)}   ${s.reason}`);
    }
    console.log("");
    console.log("  These scenarios verified NOTHING. Coverage was reduced.");
    console.log(`  Details: test-results/coverage.json`);
    if (allowed) {
      console.log("  ALLOW_INCOMPLETE=true - exiting 0 despite the gap.");
    } else {
      console.log("  Exiting non-zero. Set ALLOW_INCOMPLETE=true to accept reduced coverage.");
    }
    console.log(bar);
    console.log("");

    if (!allowed) {
      messages.push(
        `Incomplete run: ${skipped.length} of ${manifest.total} scenarios did not execute. ` +
          `Set ALLOW_INCOMPLETE=true to accept reduced coverage.`
      );
    }

    // Picked up by getLastError() above - fails the run even though every test
    // that actually ran passed. Combined, since getLastError returns one error
    // and both conditions can fire in the same run.
    if (messages.length > 0) this._error = new Error(messages.join(" "));
  }
}

module.exports = IncompleteRunReporter;
