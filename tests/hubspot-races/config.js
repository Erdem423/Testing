/**
 * Runtime config for the HubSpot concurrency-race folder.
 *
 * The HubSpot counterpart of tests/races/config.js - same shape, same
 * reasoning. These scenarios provision their own throwaway HubSpot
 * connection, so they need HubSpot's credentials rather than any of their
 * own.
 */
module.exports = {
  // See tests/races/config.js for what this does and why the dashboard needs
  // it: this folder exercises the HubSpot connector under manufactured
  // concurrent load, and has no catalog of its own to be discovered by.
  racesFor: "hubspot",
  requiredEnv: [],
  usesStripeClient: false,
  supportsCaching: true,
};
