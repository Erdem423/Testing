/**
 * Minimal wrapper around the Peaka Partner API.
 * Docs: https://docs.peaka.com/api-reference/introduction
 *
 * Uses global fetch (Node 18+). No external HTTP dependency needed.
 *
 * PATH VERIFICATION STATUS: every path in this file has now been checked
 * against Peaka's published API reference. The full endpoint index lives at
 * https://docs.peaka.com/llms.txt (linked from the API introduction page) -
 * use that if you need to verify a new endpoint, rather than trying to
 * deep-fetch individual doc pages, which is what previously failed here and
 * left seven of these paths marked "best-effort" for a while.
 *
 * That verification found three genuinely wrong paths, since corrected:
 *   triggerIncrementalUpdate  /incremental        -> /incrementalUpdate
 *   triggerFullRefresh        /full-refresh       -> /fullRefreshUpdate
 *   cancelFullRefresh         /full-refresh/cancel -> /cancelFullRefreshUpdate
 * None of them had ever failed visibly, because no test calls these methods
 * yet - worth knowing if you wire them into a scenario later.
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

  // Fetches catalog details (id, name, displayName, catalogType,
  // connectionId) for a pre-existing catalog.
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

  // Returns { isCached, isCacheable, supportedCacheTypes } for one table.
  // isCached is what makes "was this query served from cache?" an assertion
  // rather than an assumption - see tests/stripe/c-data-and-cache.js.
  isTableCached(catalogId, schemaName, tableName) {
    return this._request(
      "GET",
      `/data/projects/${this.projectId}/catalogs/${catalogId}/schemas/${schemaName}/tables/${tableName}/isCached`
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
    return this._request("POST", `/data/projects/${this.projectId}/cache/${cacheId}/incrementalUpdate`);
  }

  triggerFullRefresh(cacheId) {
    return this._request("POST", `/data/projects/${this.projectId}/cache/${cacheId}/fullRefreshUpdate`);
  }

  cancelFullRefresh(cacheId) {
    return this._request("POST", `/data/projects/${this.projectId}/cache/${cacheId}/cancelFullRefreshUpdate`);
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
