const { PeakaClient, BASE_URL } = require("./peakaClient");

/**
 * Account-level discovery for the web dashboard's project/connector picker.
 * Unlike PeakaClient (which is scoped to one projectId from the moment it's
 * constructed), these calls walk UP from just an API key to find which
 * projects it can even see - organizations -> workspaces -> projects - per
 * Peaka's Partner API reference (organization--organizations,
 * organization--workspaces, organization--projects). Same Bearer-key auth as
 * peakaClient.js, just no projectId in scope yet.
 */

async function _get(apiKey, path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    // no body
  }
  return { status: res.status, ok: res.ok, body: json };
}

function listOrganizations(apiKey) {
  return _get(apiKey, `/organizations`);
}

function listWorkspaces(apiKey, orgId) {
  return _get(apiKey, `/organizations/${orgId}/workspaces`);
}

function listProjects(apiKey, orgId, workspaceId) {
  return _get(apiKey, `/organizations/${orgId}/workspaces/${workspaceId}/projects`);
}

/**
 * Walks orgs -> workspaces -> projects and flattens the result into one
 * list, tagged with which org/workspace each project came from (useful if
 * the account has more than one of either). Best-effort per branch - one
 * organization or workspace failing to list doesn't blank out the rest,
 * same defensive spirit as helpers/cleanup.js's per-item error capture.
 */
async function discoverAllProjects(apiKey) {
  const orgsRes = await listOrganizations(apiKey);
  if (!orgsRes.ok) {
    // .status is read by server.js to tell "key is invalid" (401) apart from
    // "key is valid but scoped to a single project, not the whole account"
    // (403 - confirmed against the real API: a project-scoped Partner API
    // key gets a hard 403 Forbidden from the org-listing endpoint even
    // though the exact same key works fine for that project's own
    // connections/catalogs/etc).
    const err = new Error(`Could not list organizations (status ${orgsRes.status}).`);
    err.status = orgsRes.status;
    throw err;
  }

  const projects = [];
  const orgs = Array.isArray(orgsRes.body) ? orgsRes.body : [];

  for (const org of orgs) {
    let workspaces = [];
    try {
      const wsRes = await listWorkspaces(apiKey, org.id);
      if (wsRes.ok && Array.isArray(wsRes.body)) workspaces = wsRes.body;
    } catch (_) {
      continue; // this org's workspaces couldn't be listed - skip, don't fail the whole discovery
    }

    for (const ws of workspaces) {
      try {
        const projRes = await listProjects(apiKey, org.id, ws.id);
        if (!projRes.ok || !Array.isArray(projRes.body)) continue;
        for (const proj of projRes.body) {
          projects.push({
            id: proj.id,
            name: proj.name,
            orgId: org.id,
            orgName: org.name,
            workspaceId: ws.id,
            workspaceName: ws.name,
          });
        }
      } catch (_) {
        continue; // this workspace's projects couldn't be listed - skip, don't fail the whole discovery
      }
    }
  }

  return projects;
}

// Per-connector default schema to try first when a catalog exposes more than
// one - matches the schema names this repo's tests/<connector>/*.js already
// assume (payment for Stripe, crm for HubSpot). Falls back to whatever
// listSchemas returns first if the connector isn't in this map or the
// default isn't present, so an unlisted connector type still resolves to
// *something* rather than erroring out.
const DEFAULT_SCHEMA_BY_CONNECTOR = {
  stripe: "payment",
  hubspot: "crm",
};

/**
 * Resolves a picked project + connection down to the catalogId/schemaName
 * the existing test scenarios need (see helpers/buildCtx.js /
 * helpers/env.js's CONNECTOR_SPECS) - the dashboard's replacement for
 * manually setting PEAKA_CATALOG_ID/PEAKA_SCHEMA_NAME in .env per connector.
 *
 * Never invents a catalog - if the selected connection has no catalog set up
 * yet in Peaka Studio, this throws with a message the caller can surface
 * directly rather than letting Jest fail confusingly deep inside a test.
 */
async function resolveDynamicConnectorConfig({ apiKey, projectId, connectionId, connectorId }) {
  const client = new PeakaClient({ apiKey, projectId });

  const catalogsRes = await client.listCatalogs();
  if (!catalogsRes.ok) {
    throw new Error(`Could not list catalogs for this project (status ${catalogsRes.status}).`);
  }
  const catalogs = Array.isArray(catalogsRes.body) ? catalogsRes.body : [];
  const catalog = catalogs.find((c) => c.connectionId === connectionId);
  if (!catalog) {
    throw new Error(
      "No catalog is set up for this connection yet - create one for it in Peaka Studio first, then try again."
    );
  }

  const schemasRes = await client.listSchemas(catalog.id);
  const schemas = schemasRes.ok && Array.isArray(schemasRes.body) ? schemasRes.body : [];
  const schemaNames = schemas.map((s) => (typeof s === "string" ? s : s.name)).filter(Boolean);
  const preferred = DEFAULT_SCHEMA_BY_CONNECTOR[connectorId];
  const schemaName = (preferred && schemaNames.includes(preferred) ? preferred : schemaNames[0]) || preferred;

  if (!schemaName) {
    throw new Error("Could not determine a schema for this connection's catalog.");
  }

  return { catalogId: catalog.id, catalogName: catalog.name, schemaName };
}

module.exports = {
  listOrganizations,
  listWorkspaces,
  listProjects,
  discoverAllProjects,
  resolveDynamicConnectorConfig,
};
