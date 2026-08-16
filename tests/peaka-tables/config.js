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
  // Not backed by a CONNECTION, unlike every other folder. Peaka Tables and
  // BI Tables live in the built-in `peaka` catalog, which comes back from
  // listCatalogs() with catalogType "internal" and a null connectionId.
  //
  // The dashboard's connector picker lists a project's catalogs and drops
  // every connectionId-less one as internal plumbing - correct for the two
  // `peaka` catalogs as CATALOGS, but it meant this folder's 22 scenarios
  // could never be reached from the UI at all. This flag says "offer this
  // folder for any project, with no connection to pick", which is exactly
  // what it needs: requiredEnv above is already empty.
  requiresConnection: false,
  requiredEnv: [],
  usesStripeClient: false,
  supportsCaching: false,
};
