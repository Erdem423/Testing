/**
 * Minimal wrapper around the Peaka Partner API.
 * Docs: https://docs.peaka.com/api-reference/introduction
 *
 * Uses global fetch (Node 18+). No external HTTP dependency needed.
 *
 * IMPORTANT - path verification status:
 * The following methods use paths CONFIRMED directly against Peaka's published
 * API docs (docs.peaka.com/api-reference/...):
 *   createConnection, createCatalog, listSchemas, listTables, listColumns,
 *   createCache, executeQuery, getCacheStatus
 *
 * The following methods use paths that are BEST-EFFORT / inferred from REST
 * convention (docs.peaka.com blocked deep-fetching these specific pages while
 * this file was written, or a search for the exact "Read Catalog" endpoint
 * came up empty) and should be double-checked against the Postman collection
 * before relying on them in CI:
 *   https://www.postman.com/peaka-api/peaka-api/collection/znssuf9/partner-api
 *   deleteConnection, deleteCatalog, deleteCache, getCatalog,
 *   triggerIncrementalUpdate, triggerFullRefresh, cancelFullRefresh
 *
 * If any of these 404, open the Postman collection above (or the OpenAPI spec
 * linked from the API introduction page) and correct the path here - the rest
 * of the test suite does not depend on getting these exactly right on day one.
 */


const BASE_URL = process.env.PEAKA_BASE_URL || "https://partner.peaka.studio/api/v1";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

class PeakaClient {
  constructor({ apiKey, projectId } = {}) {
    this.apiKey = apiKey || requireEnv("PEAKA_API_KEY");
    this.projectId = projectId || requireEnv("PEAKA_PROJECT_ID");
  }

  async _request(method, path, { body, query } = {}) {
    let url = `${BASE_URL}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      url += `?${qs}`;
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      // some endpoints may return empty body (e.g. DELETE)
    }

    return { status: res.status, ok: res.ok, body: json };
  }

  // ---- Connections ----
  createConnection({ name, type, credential, connectionCallback }) {
    return this._request("POST", `/connections/${this.projectId}`, {
      body: { name, type, credential, connectionCallback },
    });
  }

  deleteConnection(connectionId) {
    return this._request("DELETE", `/connections/${this.projectId}/${connectionId}`);
  }

  // ---- Catalogs ----
  createCatalog({ name, connectionId, extraParameters }) {
    return this._request("POST", `/data/projects/${this.projectId}/catalogs`, {
      body: { name, connectionId, extraParameters },
    });
  }

  // BEST-EFFORT path - see header. Fetches catalog details (id, name/slug,
  // displayName, catalogType, connectionId) for a pre-existing catalog.
  getCatalog(catalogId) {
    return this._request("GET", `/data/projects/${this.projectId}/catalogs/${catalogId}`);
  }

  deleteCatalog(catalogId) {
    return this._request("DELETE", `/data/projects/${this.projectId}/catalogs/${catalogId}`);
  }

  listSchemas(catalogId) {
    return this._request("GET", `/data/projects/${this.projectId}/catalogs/${catalogId}/schemas`);
  }

  listTables(catalogId, schemaName) {
    return this._request(
      "GET",
      `/data/projects/${this.projectId}/catalogs/${catalogId}/schemas/${schemaName}/tables`
    );
  }

  listColumns(catalogId, schemaName, tableName) {
    return this._request(
      "GET",
      `/data/projects/${this.projectId}/catalogs/${catalogId}/schemas/${schemaName}/tables/${tableName}/columns`
    );
  }

  // ---- Cache ----
  createCache({ catalogId, schemaName, tableName, incrementalCacheSchedule, fullRefreshCacheSchedule }) {
    return this._request("POST", `/data/projects/${this.projectId}/cache`, {
      body: { catalogId, schemaName, tableName, incrementalCacheSchedule, fullRefreshCacheSchedule },
    });
  }

  deleteCache(cacheId) {
    return this._request("DELETE", `/data/projects/${this.projectId}/cache/${cacheId}`);
  }

  getCacheStatus(cacheId) {
    return this._request("GET", `/data/projects/${this.projectId}/cache/${cacheId}/status`);
  }

  triggerIncrementalUpdate(cacheId) {
    return this._request("POST", `/data/projects/${this.projectId}/cache/${cacheId}/incremental`);
  }

  triggerFullRefresh(cacheId) {
    return this._request("POST", `/data/projects/${this.projectId}/cache/${cacheId}/full-refresh`);
  }

  cancelFullRefresh(cacheId) {
    return this._request("POST", `/data/projects/${this.projectId}/cache/${cacheId}/full-refresh/cancel`);
  }

  // ---- Queries ----
  executeQuery(payload, format = "SIMPLE") {
    return this._request("POST", `/data/projects/${this.projectId}/queries/execute`, {
      body: payload,
      query: { format },
    });
  }
}

module.exports = { PeakaClient, BASE_URL };
