/**
 * Runtime config for the Peaka Tables connector folder (Peaka Table / Peaka
 * BI Table scenarios from the instructor's source doc).
 *
 * Needs nothing beyond the core PEAKA_API_KEY/PEAKA_PROJECT_ID every
 * connector already requires. Unlike stripe/postgres there is no connection
 * or catalog to create or point at - both table kinds live in the
 * always-present `peaka` catalog.
 */
module.exports = {
  requiredEnv: [],
  usesStripeClient: false,
  supportsCaching: false,
};
