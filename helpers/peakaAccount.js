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

const { loadConnectorConfig } = require("./env");

/**
 * Picks which schema of a catalog to test.
 *
 * ORDER MATTERS, and "first one listed" is the last resort rather than the
 * rule. Measured live: Postgres exposes ten schemas with `auth` first and the
 * one this suite actually targets (`public`) seventh; MongoDB lists
 * `database_1` before the `e_commerce` the fixtures use. Taking the first
 * would run a whole folder against the wrong data and report confusing
 * failures rather than an honest error.
 *
 *   1. whatever the connector's own schemaEnv already names, if the catalog
 *      really has it - the user has stated their intent in .env, so honour it
 *   2. a defaultSchema declared in tests/<id>/config.js
 *   3. the first schema listed, as a guess for a connector that declares
 *      neither
 *
 * RETURNS WHY, NOT JUST WHAT. Step 3 is a guess, and a silent guess is how a
 * MongoDB connection holding `peaka_schema_db` (no `e_commerce` anywhere in
 * it) came to run the whole folder against sample data and report "no
 * collection exceeds 100 rows" - a confusing failure three layers away from
 * its cause, exactly what the comment above warns about. The caller surfaces
 * `notice` so the guess is visible before the run rather than deduced after
 * it.
 */
function pickSchema(connectorId, schemaNames) {
  const config = loadConnectorConfig(connectorId) || {};
  const fromEnv = config.schemaEnv ? process.env[config.schemaEnv] : null;
  if (fromEnv && schemaNames.includes(fromEnv)) return { name: fromEnv, source: "env", notice: null };
  if (config.defaultSchema && schemaNames.includes(config.defaultSchema)) {
    return { name: config.defaultSchema, source: "default", notice: null };
  }

  const guess = schemaNames[0] || config.defaultSchema || fromEnv || null;
  if (!guess) return { name: null, source: "none", notice: null };

  const wanted = config.defaultSchema || fromEnv;
  return {
    name: guess,
    source: schemaNames[0] ? "first-listed" : "unverified-default",
    notice: wanted
      ? `This connection's catalog has no '${wanted}' schema, so the run will use '${guess}' instead ` +
        `(schemas found: ${schemaNames.join(", ") || "none"}). Scenarios written around '${wanted}' may ` +
        `find different data than they expect.`
      : `No schema is configured for this connector, so the run will use the first one listed, '${guess}'.`,
  };
}

/**
 * Picks the schema with the most data in it, by MEASURING rather than by
 * position in the list.
 *
 * WHY: "the first schema listed" is not a heuristic, it is a coin flip. On a
 * live MongoDB connection it chose `peaka_schema_db` - a Peaka scratch
 * database holding one collection with ONE row - while `sample_training`
 * (100,000 rows) and `sample_mflix` (21,349) sat further down the same list.
 * Every scenario that needs a table bigger than the row cap then skipped, and
 * the run looked like the connection had no data when it had plenty.
 *
 * A test suite should not depend on a schema being NAMED a particular thing.
 * `defaultSchema` in tests/<id>/config.js stays as a preference - it is right
 * nearly always and costs nothing to check - but when the catalog does not
 * have it, this looks at what is actually there instead of guessing.
 *
 * DELIBERATELY BOUNDED, because this runs while someone waits on a dashboard
 * click: schemas are ranked by table count first (pure metadata, no queries),
 * then at most MAX_SCHEMAS_PROBED x MAX_TABLES_PROBED COUNT(*) queries run,
 * and it stops at the first table big enough that no gate could want more.
 */
const MAX_SCHEMAS_PROBED = 4;
const MAX_TABLES_PROBED = 2;
const ENOUGH_ROWS = 100; // helpers/preflight.js's CAP_PROBE_MIN_ROWS - past this, no gate asks for more

async function chooseSchemaWithData(client, catalogId, catalogName, schemaNames) {
  const withTables = [];
  for (const schemaName of schemaNames) {
    const res = await client.listTables(catalogId, schemaName);
    const tables = res.ok && Array.isArray(res.body) ? res.body.map((t) => t.tableName).filter(Boolean) : [];
    if (tables.length) withTables.push({ schemaName, tables });
  }
  if (!withTables.length) return null;

  withTables.sort((a, b) => b.tables.length - a.tables.length);

  let best = null;
  for (const candidate of withTables.slice(0, MAX_SCHEMAS_PROBED)) {
    for (const tableName of candidate.tables.slice(0, MAX_TABLES_PROBED)) {
      let rows = null;
      try {
        const res = await client.executeQuery(
          { statement: `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${candidate.schemaName}"."${tableName}"` },
          "SIMPLE"
        );
        if (res.ok && res.body && res.body.data && res.body.data.length) rows = Number(res.body.data[0].cnt);
      } catch (_) {
        continue; // a table that will not answer is not the one to judge a schema by
      }
      if (rows === null) continue;
      if (!best || rows > best.rows) best = { schemaName: candidate.schemaName, tableName, rows };
      if (best.rows > ENOUGH_ROWS) return best;
    }
  }
  return best || { schemaName: withTables[0].schemaName, tableName: null, rows: null };
}

/**
 * Resolves a picked project + connection down to the catalogId/schemaName
 * the existing test scenarios need (see helpers/buildCtx.js and each
 * connector's tests/<id>/config.js) - the dashboard's replacement for
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
  // NOT SWALLOWED. This used to fall through to `[]` on any failure, which
  // pickSchema then turned into "use the declared default" - so a 403 or a
  // 500 became a run against a schema nobody had confirmed exists, with the
  // status code never mentioned anywhere.
  if (!schemasRes.ok) {
    throw new Error(
      `Could not list the schemas of catalog '${catalog.name}' (status ${schemasRes.status}), so there is ` +
        `no way to tell which schema this connection should be tested against.`
    );
  }
  const schemas = Array.isArray(schemasRes.body) ? schemasRes.body : [];
  // The API returns `schemaName`, not `name` - reading the wrong field made
  // this list ALWAYS empty, which went unnoticed because Stripe and HubSpot
  // both had a hardcoded default to fall back on. Every other connector hit
  // "Could not determine a schema" the moment the picker started offering
  // them. `name` is kept as a tolerated alternative rather than assumed away.
  const schemaNames = schemas.map((s) => (typeof s === "string" ? s : s.schemaName || s.name)).filter(Boolean);
  let picked = pickSchema(connectorId, schemaNames);

  // Only when the connector's own preference is not in this catalog. The
  // ordinary case (e_commerce / public / crm / payment present) never probes.
  if (picked.source === "first-listed") {
    const measured = await chooseSchemaWithData(client, catalog.id, catalog.name, schemaNames);
    if (measured) {
      const config = loadConnectorConfig(connectorId) || {};
      const wanted = config.defaultSchema || (config.schemaEnv ? process.env[config.schemaEnv] : null);
      picked = {
        name: measured.schemaName,
        source: "measured",
        notice:
          (wanted ? `This connection's catalog has no '${wanted}' schema. ` : "No schema is configured for this connector. ") +
          `Measured the alternatives and picked '${measured.schemaName}'` +
          (measured.tableName ? ` (largest sampled table: '${measured.tableName}', ${measured.rows} rows)` : "") +
          `. Scenarios needing more rows than that will say so individually.`,
      };
    }
  }

  if (!picked.name) {
    throw new Error("Could not determine a schema for this connection's catalog.");
  }

  return {
    catalogId: catalog.id,
    catalogName: catalog.name,
    schemaName: picked.name,
    // Non-fatal, and deliberately not an error: running against another
    // schema is often exactly right (a project whose Mongo connection holds
    // only sample data still has plenty worth testing). It just must not
    // happen invisibly.
    schemaNotice: picked.notice,
  };
}

module.exports = {
  listOrganizations,
  listWorkspaces,
  listProjects,
  discoverAllProjects,
  resolveDynamicConnectorConfig,
};
