const { PeakaClient } = require("./peakaClient");
const { loadConnectorConfig } = require("./env");
const { resolveDynamicConnectorConfig, discoverAllProjects } = require("./peakaAccount");
const fs = require("fs");
const path = require("path");

/**
 * Fills in each connector's catalog/schema/connection env vars by LOOKING AT
 * THE PROJECT, for anything the user has not set explicitly.
 *
 * WHY: the dashboard has resolved these dynamically for a while - you connect
 * with a key, pick a project, and it works out the rest. The CLI never got
 * that, so `npm test` still demanded PEAKA_MONGO_CATALOG_ID,
 * PEAKA_MONGO_SCHEMA_NAME, PEAKA_PG_CATALOG_ID, PEAKA_HUBSPOT_CATALOG_ID and
 * the rest by hand, and reported "MongoDB connector not configured (missing
 * PEAKA_MONGO_* in .env)" for every gate of every connector that had not been
 * filled in - which, on a fresh clone, is all of them.
 *
 * Nothing here overrides a value that is already set: an explicit env var is
 * someone stating their intent, and it wins. This only fills gaps.
 *
 * Runs once, in jest.globalSetup.js, before any test file loads. Jest forks
 * its workers from that process, so what is written to process.env here is
 * what every worker and the preflight sees.
 */
const FOLDER_TO_CONNECTOR = { races: "stripe", "hubspot-races": "hubspot" };

/**
 * Finds which project this key can see that holds a catalog of one of
 * `catalogTypes`. Cached for the process: the answer cannot change mid-run and
 * the scan costs one listCatalogs per project.
 */
const projectSearchCache = new Map();

async function findProjectHoldingCatalogType(apiKey, catalogTypes) {
  const types = catalogTypes.map((t) => String(t).toLowerCase());
  if (!types.length) return null;
  const cacheKey = types.join(",");
  if (projectSearchCache.has(cacheKey)) return projectSearchCache.get(cacheKey);

  let found = null;
  try {
    const projects = await discoverAllProjects(apiKey);
    for (const project of projects) {
      const client = new PeakaClient({ apiKey, projectId: project.id });
      const res = await client.listCatalogs();
      if (!res.ok || !Array.isArray(res.body)) continue;
      if (res.body.some((c) => types.includes(String(c.catalogType).toLowerCase()))) {
        found = project.id;
        break;
      }
    }
  } catch (_) {
    found = null; // best-effort, exactly like the rest of this module
  }
  projectSearchCache.set(cacheKey, found);
  return found;
}

async function autoConfigureConnectors({ log = () => {}, only = null } = {}) {
  // Scoped the same way as the preflight: a dashboard run of one folder has no
  // business resolving catalogs for connectors it will not execute.
  const scope = only ? FOLDER_TO_CONNECTOR[only] || only : null;
  const apiKey = process.env.PEAKA_API_KEY;
  const projectId = process.env.PEAKA_PROJECT_ID;
  if (!apiKey || !projectId) return []; // nothing to discover against - the core check will say so

  const connectorIds = fs
    .readdirSync(path.join(__dirname, "..", "tests"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const filled = [];

  for (const connectorId of connectorIds) {
    if (scope && connectorId !== scope) continue;
    const config = loadConnectorConfig(connectorId);
    if (!config || !config.catalogIdEnv) continue; // connection-less (peaka-tables) or a race companion

    // A connector can address a DIFFERENT project than the one under test -
    // Google Ads does, via apiKeyEnv/projectIdEnv. Those exist because the
    // suite once used two API keys, each scoped to one project. A single
    // Partner key that can see several projects makes that split unnecessary,
    // so rather than declaring the connector unconfigured, look for its
    // catalog in the OTHER projects this key can reach.
    let key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : apiKey;
    let proj = config.projectIdEnv ? process.env[config.projectIdEnv] : projectId;

    if (!key) key = apiKey;
    if (!proj) {
      proj = await findProjectHoldingCatalogType(apiKey, config.catalogTypes || []);
      if (!proj) continue; // no project this key can see has one - genuinely absent
      // Write both back, because checkCredentials() reads exactly these names.
      if (config.projectIdEnv) process.env[config.projectIdEnv] = proj;
      if (config.apiKeyEnv && !process.env[config.apiKeyEnv]) process.env[config.apiKeyEnv] = apiKey;
    }

    const needsCatalog = !process.env[config.catalogIdEnv];
    const needsSchema = config.schemaEnv && !process.env[config.schemaEnv];
    const needsConnection = config.connectionIdEnv && !process.env[config.connectionIdEnv];
    if (!needsCatalog && !needsSchema && !needsConnection) continue;

    let catalog = null;
    try {
      const client = new PeakaClient({ apiKey: key, projectId: proj });
      const res = await client.listCatalogs();
      if (!res.ok || !Array.isArray(res.body)) continue;
      const types = (config.catalogTypes || []).map((t) => String(t).toLowerCase());
      catalog = res.body.find((c) => types.includes(String(c.catalogType).toLowerCase()));
      if (!catalog) continue; // this project simply has no such connector - not an error
    } catch (_) {
      continue; // discovery is best-effort; the ordinary credential check reports the gap
    }

    if (needsCatalog) process.env[config.catalogIdEnv] = String(catalog.id);
    if (needsConnection && catalog.connectionId) process.env[config.connectionIdEnv] = String(catalog.connectionId);
    if (config.catalogNameEnv && !process.env[config.catalogNameEnv] && catalog.name) {
      process.env[config.catalogNameEnv] = catalog.name;
    }

    if (needsSchema) {
      try {
        // Reuses the dashboard's resolver, so the CLI and the dashboard pick
        // the same schema by the same measurement rather than by two rules.
        const resolved = await resolveDynamicConnectorConfig({
          apiKey: key,
          projectId: proj,
          connectionId: catalog.connectionId,
          connectorId,
        });
        process.env[config.schemaEnv] = resolved.schemaName;
      } catch (_) {
        continue;
      }
    }

    filled.push(`${connectorId} -> catalog ${process.env[config.catalogIdEnv]}, schema ${process.env[config.schemaEnv]}`);
  }

  if (filled.length) {
    log(`Discovered connector settings not present in .env:\n  ${filled.join("\n  ")}`);
  }
  return filled;
}

module.exports = { autoConfigureConnectors };
