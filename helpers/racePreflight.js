/**
 * Refuses to start the race suite when another test run appears to be active.
 *
 * These tests manufacture concurrency conflicts on purpose. If a second suite
 * is running against the same Peaka project, it creates UNINTENDED races on
 * top of the intended ones, and the result looks exactly like a code
 * regression. That has happened twice during development:
 *
 *   - a stray `node server.js` alongside `npm test` -> 3x slowdown, four
 *     spurious failures;
 *   - a dashboard race run, then `npm run test:races`, with a stray server
 *     still alive -> all three tiers failed and their times roughly doubled.
 *     Re-run in a quiet environment: all green, code unchanged.
 *
 * Failing fast with "another run appears to be active" costs seconds. Not
 * failing costs several minutes of confusing red plus the debugging that
 * follows, which is how both incidents above played out.
 */

/** Is the dashboard serving? It runs real Jest suites against the same project. */
async function dashboardIsRunning(port = process.env.PORT || 3000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/folders`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch (_) {
    return false; // nothing listening, or not our server - either way, fine
  }
}

/**
 * A cache mid-sync strongly implies a live run elsewhere. Settled caches are
 * only debris - the race scenarios clear those themselves - so they do not
 * block, they just get reported.
 */
async function activeCaches(client) {
  const res = await client.getAllCacheStatusesOfProject();
  if (res.status !== 200 || !Array.isArray(res.body)) return { running: [], settled: [] };
  const running = [];
  const settled = [];
  for (const c of res.body) {
    const status = String(c.status || "").toUpperCase();
    (status === "RUNNING" || status === "NOT_INITIALIZED" ? running : settled).push(
      `${c.tableName} (${c.status})`
    );
  }
  return { running, settled };
}

/**
 * Throws if it looks unsafe to start. Call from beforeAll in the race suites.
 */
async function assertSafeToRaceOrThrow(client, log = console.log) {
  const problems = [];

  if (await dashboardIsRunning()) {
    problems.push(
      "The web dashboard is responding on port 3000. It runs the same Jest suites against the same " +
        "Peaka project, so leaving it up while these run produces unintended races. Stop it first " +
        "(on Windows `pkill` from Git Bash does NOT reliably kill it - use PowerShell Get-CimInstance)."
    );
  }

  const { running, settled } = await activeCaches(client);
  if (running.length > 0) {
    problems.push(
      `Cache(s) are mid-sync: ${running.join(", ")}. That strongly suggests another run is active. ` +
        `Wait for it to finish rather than racing it.`
    );
  }
  if (settled.length > 0) {
    log(
      `note: ${settled.length} settled cache(s) already exist (${settled.join(", ")}). Not blocking - the ` +
        `scenarios clear their own fixtures - but they are debris from an earlier run.`
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start the concurrency races - another test run appears to be active:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nThese tests deliberately create races; overlapping them with anything else produces ` +
        `failures that look like code regressions but are not.`
    );
  }
}

module.exports = { assertSafeToRaceOrThrow, dashboardIsRunning, activeCaches };
