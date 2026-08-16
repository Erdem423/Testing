/**
 * Runtime config for the Stripe concurrency-race folder.
 *
 * These scenarios build their own throwaway Stripe connection (see
 * tests/races/tier1.js), so they need exactly the credentials the Stripe
 * folder needs and nothing of their own - hence no requiredEnv here beyond
 * what `racesFor` pulls in.
 */
module.exports = {
  // This folder is not a connector of its own - it exercises the SAME
  // connector as tests/stripe/, under deliberately manufactured concurrent
  // load, and lives apart only so it never runs alongside the main suite
  // (see jest.config.js's testPathIgnorePatterns).
  //
  // The dashboard reads this to offer the folder as a companion entry beside
  // its parent connector rather than as a separate connection. Without it,
  // races had no catalog of its own and so could never appear in the picker
  // at all - a whole folder unreachable from the UI.
  racesFor: "stripe",
  requiredEnv: [],
  usesStripeClient: true,
  supportsCaching: true,
};
