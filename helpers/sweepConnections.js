/**
 * Deletes abandoned test connections left by runs that were killed before
 * their cleanup could run.
 *
 * WHY THIS IS NEEDED AT ALL. helpers/cleanup.js only ever deletes ids the
 * CURRENT run recorded - deliberately, so it can never touch the user's real
 * connections. The gap that leaves: kill a process between "connection
 * created" and afterAll, and that connection is stranded with nothing able to
 * find it afterwards. This project carries 11 such orphans from July 2026
 * under an older naming scheme.
 *
 * WHY AN AGE GUARD RATHER THAN A BARE PREFIX MATCH. Scenario names embed
 * runTag - `${Date.now()}-${random}` - so every run's connections share a
 * prefix but differ in timestamp. A naive "delete everything matching the
 * prefix" sweep would delete a LIVE connection belonging to a run happening
 * concurrently: two developers against one project, or CI overlapping with a
 * local run. That would surface as a bizarre mid-test failure in the other
 * person's run, which is a far worse problem than the debris being cleaned up.
 *
 * So a connection is only swept when its embedded timestamp is old enough
 * that no run could still be using it. The races suite is the longest at
 * ~10 minutes; one hour is comfortably beyond anything.
 *
 * Names WITHOUT a parseable timestamp are swept only if they match a known
 * legacy prefix - see LEGACY_PREFIXES. Anything unrecognised is left alone.
 */

// Longest suite (races) is ~10 min. An hour is well clear of it.
const STALE_AFTER_MS = 60 * 60 * 1000;

// Naming schemes retired before runTag existed, so they carry no timestamp and
// cannot be age-checked. They are unambiguously test debris - nothing in the
// codebase creates these any more - so they are always safe to remove.
const LEGACY_PREFIXES = ["test-stripe-conn-"];

/** Pulls the ms timestamp out of a runTag-suffixed name, or null. */
function timestampFromName(name) {
  // runTag() is `${Date.now()}-${base36}`, so the last 13-digit run of digits
  // preceded by a hyphen is the creation time.
  const match = String(name).match(/-(\d{13})-[a-z0-9]+$/i);
  return match ? Number(match[1]) : null;
}

/**
 * @param {object} ctx           run context (needs .client)
 * @param {string} prefix        e.g. "e2e-auto-conn"
 * @param {(line: string) => void} log
 * @returns {Promise<{swept: string[], skipped: string[]}>}
 */
async function sweepStaleConnections(ctx, prefix, log = console.log) {
  const res = await ctx.client.listConnections();
  if (!res.ok || !Array.isArray(res.body)) {
    log(`  sweep skipped: listConnections returned ${res.status}`);
    return { swept: [], skipped: [] };
  }

  const now = Date.now();
  const swept = [];
  const skipped = [];

  for (const conn of res.body) {
    const name = String(conn.name || "");
    const isLegacy = LEGACY_PREFIXES.some((p) => name.startsWith(p));
    const isOurs = name.startsWith(prefix);
    if (!isLegacy && !isOurs) continue;

    if (isOurs && !isLegacy) {
      const ts = timestampFromName(name);
      // No parseable timestamp: cannot prove it is abandoned, so leave it.
      if (ts === null) {
        skipped.push(`${name} (no timestamp - cannot confirm it is abandoned)`);
        continue;
      }
      if (now - ts < STALE_AFTER_MS) {
        skipped.push(`${name} (only ${Math.round((now - ts) / 1000)}s old - may belong to a concurrent run)`);
        continue;
      }
    }

    const del = await ctx.client.deleteConnection(conn.id);
    if (del.ok) {
      swept.push(name);
      log(`  swept abandoned connection ${name}`);
    } else {
      log(`  could not sweep ${name} (status ${del.status})`);
    }
  }

  if (swept.length === 0 && skipped.length === 0) log("  no abandoned connections found");
  for (const s of skipped) log(`  left alone: ${s}`);

  return { swept, skipped };
}

module.exports = { sweepStaleConnections, timestampFromName, STALE_AFTER_MS, LEGACY_PREFIXES };
