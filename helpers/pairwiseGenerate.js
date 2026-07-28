/**
 * Pairwise ("all-pairs") combination generator - a homemade, dependency-free
 * alternative to Microsoft's PICT, sized for problems as small as ours (a
 * handful of parameters, a handful of values each).
 *
 * Given parameters like:
 *   { Table: ["customers", "charges"], Format: ["SIMPLE", "COMPACT"] }
 *
 * produces a SMALL set of full combinations (one value per parameter, per
 * row) such that every PAIR of values across two different parameters
 * appears together in at least one row - without needing every single full
 * combination.
 *
 * This helper is deliberately CONNECTOR-AGNOSTIC - it knows nothing about
 * Stripe, Peaka, or any specific API. It's pure combinatorics. That's what
 * makes it reusable for future connectors (Mongo, Supabase, etc.) too - each
 * connector's own tests would define their own dimensions (their own tables,
 * their own config options) and call this same function, rather than each
 * connector needing its own copy of the algorithm.
 *
 * Algorithm: simple greedy set cover. Since our whole parameter space is
 * small enough to enumerate outright (hundreds of combinations, not
 * millions), each greedy step evaluates every possible combination and picks
 * the true best one - not an approximation.
 *
 * Verified (see jest/unit/pairwiseGenerate.test.js):
 *   - Every required pair is independently re-verified as covered (not just
 *     trusting the algorithm's own internal bookkeeping)
 *   - Same seed produces identical output every time; different seeds
 *     produce genuinely different (but still fully covering) output
 *   - Benchmarked against a known published PICT example (5 binary
 *     parameters, published result: 7 rows) - this implementation produced
 *     6 rows, in the same quality range as the real tool
 */

/** Generates every full combination (cartesian product) of the given params. */
function allCombinations(params) {
  const names = Object.keys(params);
  let combos = [{}];
  for (const name of names) {
    const next = [];
    for (const combo of combos) {
      for (const value of params[name]) {
        next.push({ ...combo, [name]: value });
      }
    }
    combos = next;
  }
  return combos;
}

/** All pair-keys a given row covers, e.g. "Table=customers|Format=SIMPLE". */
function pairsInRow(row, names) {
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

/**
 * @param {Object<string, Array>} params - e.g. { Table: [...], Format: [...] }
 * @param {number} [seed] - optional seed for reproducible tie-breaking among
 *   equally-good candidate rows (mirrors PICT's /r:N flag) - same seed always
 *   produces the same output.
 * @returns {Array<Object>} the generated rows
 */
function generatePairwise(params, seed = 42) {
  const names = Object.keys(params);
  const all = allCombinations(params);

  // Every pair that MUST appear in at least one output row.
  const required = new Set();
  for (const combo of all) {
    for (const pairKey of pairsInRow(combo, names)) {
      required.add(pairKey);
    }
  }

  // Simple seeded shuffle so tie-breaking is reproducible, not JS's
  // insertion-order-dependent default (mirrors PICT's /r:N).
  let rngState = seed;
  function seededRandom() {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  }
  function shuffled(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  const uncovered = new Set(required);
  const result = [];
  const shuffledAll = shuffled(all);

  while (uncovered.size > 0) {
    let best = null;
    let bestNewPairsCount = -1;

    for (const combo of shuffledAll) {
      const newPairs = pairsInRow(combo, names).filter((p) => uncovered.has(p));
      if (newPairs.length > bestNewPairsCount) {
        best = combo;
        bestNewPairsCount = newPairs.length;
      }
    }

    result.push(best);
    for (const p of pairsInRow(best, names)) {
      uncovered.delete(p);
    }
  }

  // Guarantee every individual (parameter, value) appears in at least one
  // row too - matters specifically when there's only a single parameter (no
  // pairs are possible at all, so the loop above never runs), but cheap and
  // correct to check unconditionally regardless of parameter count.
  const coveredValues = new Set();
  for (const row of result) {
    for (const name of names) {
      coveredValues.add(`${name}=${row[name]}`);
    }
  }
  for (const name of names) {
    for (const value of params[name]) {
      const key = `${name}=${value}`;
      if (!coveredValues.has(key)) {
        const combo = all.find((c) => c[name] === value);
        result.push(combo);
        coveredValues.add(key);
      }
    }
  }

  return result;
}

module.exports = { generatePairwise, allCombinations, pairsInRow };
