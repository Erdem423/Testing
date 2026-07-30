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

  listConnections() {
    return this._request("GET", `/connections/${this.projectId}`);
  }

  // Returns connection metadata only - id/name/type/url. Per the reference,
  // the credential is deliberately NOT included, which is what the
  // credential-masking check in tests/stripe/g-connections.js verifies.
  getConnection(connectionId) {
    return this._request("GET", `/connections/${this.projectId}/${connectionId}`);
  }

  updateConnection(connectionId, { name, type, credential, connectionCallback }) {
    return this._request("PUT", `/connections/${this.projectId}/${connectionId}`, {
      body: { name, type, credential, connectionCallback },
    });
  }

  deleteConnection(connectionId) {
    return this._request("DELETE", `/connections/${this.projectId}/${connectionId}`);
  }

  // Project-independent: the catalogue of connector types Peaka supports.
  listConnectionConfig() {
    return this._request("GET", `/connections/config`);
  }

  getConnectionConfig(connectionType) {
    return this._request("GET", `/connections/config/${connectionType}`);
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

  listCatalogs() {
    return this._request("GET", `/data/projects/${this.projectId}/catalogs`);
  }

  deleteCatalog(catalogId) {
    return this._request("DELETE", `/data/projects/${this.projectId}/catalogs/${catalogId}`);
  }

  // Case-insensitive search across catalogs/schemas/tables in the project.
  search({ query, catalog, schema, limit, offset }) {
    return this._request("POST", `/data/projects/${this.projectId}/search`, {
      body: { query, catalog, schema, limit, offset },
    });
  }

  // Per-column distinctFraction only - note there is NO row count here, so
  // this can't be used to work around the 100-row live-read cap.
  getTableStatistics(catalogId, schemaName, tableName) {
    return this._request(
      "GET",
      `/data/projects/${this.projectId}/catalogs/${catalogId}/schemas/${schemaName}/tables/${tableName}/statistics`
    );
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

  // Creates several caches in one call. Peaka processes them independently -
  // one failing doesn't prevent the others, so the response is an array of
  // { success, error?, cache? } rather than a single status.
  createCacheBatch(cacheRequests) {
    return this._request("POST", `/data/projects/${this.projectId}/cache/batch`, { body: cacheRequests });
  }

  deleteCache(cacheId) {
    return this._request("DELETE", `/data/projects/${this.projectId}/cache/${cacheId}`);
  }

  // NOTE: distinct from getCacheStatus. This is "Get Cache Settings" - it
  // returns the cache's CONFIG (schedules), not its execution state. Easy to
  // confuse, since the paths differ only by the /status suffix.
  getCacheSettings(cacheId) {
    return this._request("GET", `/data/projects/${this.projectId}/cache/${cacheId}`);
  }

  // Only the two schedules are mutable; catalog/schema/table are fixed at
  // creation. type is "BASIC" or "NONE"; expression is an ISO-8601 duration.
  updateCacheSettings(cacheId, { incrementalCacheSchedule, fullRefreshCacheSchedule }) {
    return this._request("PUT", `/data/projects/${this.projectId}/cache/${cacheId}`, {
      body: { incrementalCacheSchedule, fullRefreshCacheSchedule },
    });
  }

  getCacheStatus(cacheId) {
    return this._request("GET", `/data/projects/${this.projectId}/cache/${cacheId}/status`);
  }

  getCacheExecutionHistory(cacheId, { limit, offset } = {}) {
    return this._request("GET", `/data/projects/${this.projectId}/cache/${cacheId}/executionHistory`, {
      query: limit || offset ? { ...(limit ? { limit } : {}), ...(offset ? { offset } : {}) } : undefined,
    });
  }

  getAllCacheStatusesOfProject() {
    return this._request("GET", `/data/projects/${this.projectId}/cache/status`);
  }

  getAllCacheStatusesOfCatalog(catalogId) {
    return this._request("GET", `/data/projects/${this.projectId}/catalog/${catalogId}/cache/status`);
  }

  // NOTE: this one is CONFIRMED to return 500 against a real project - see
  // the README's "Known gaps". Kept because the path is correct per the
  // reference; the test accepts the 500 with a loud log rather than staying
  // permanently red.
  getAllCacheStatusesOfSchema(catalogId, schemaName) {
    return this._request(
      "GET",
      `/data/projects/${this.projectId}/catalog/${catalogId}/schema/${schemaName}/cache/status`
    );
  }

  cancelIncrementalUpdate(cacheId) {
    return this._request("POST", `/data/projects/${this.projectId}/cache/${cacheId}/cancelIncrementalUpdate`);
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

  // queryType: "PLAIN" (default) or "MATERIALIZED". Only PLAIN is exercised
  // by the suite so far - see the deferred list in the plan/README.
  createQuery({ displayName, inputQuery, queryType, inputQueryRefId, path, schedule }) {
    return this._request("POST", `/data/projects/${this.projectId}/queries`, {
      body: { displayName, inputQuery, queryType, inputQueryRefId, path, schedule },
    });
  }

  listQueries() {
    return this._request("GET", `/data/projects/${this.projectId}/queries`);
  }

  getQuery(queryId) {
    return this._request("GET", `/data/projects/${this.projectId}/queries/${queryId}`);
  }

  // Omitted fields keep their current values.
  updateQuery(queryId, body) {
    return this._request("PUT", `/data/projects/${this.projectId}/queries/${queryId}`, { body });
  }

  deleteQuery(queryId) {
    return this._request("DELETE", `/data/projects/${this.projectId}/queries/${queryId}`);
  }

  // ---- Materialized queries ----
  // A materialized query is created via createQuery with
  // queryType: "MATERIALIZED". inputQueryRefId is OPTIONAL - inputQuery
  // alone is enough (verified 2026-07-29); when a ref id IS given, Peaka
  // copies the referenced query's SQL into the new query.
  getMaterializedQueryStatus(queryId) {
    return this._request("GET", `/data/projects/${this.projectId}/materialized-queries/${queryId}/status`);
  }

  listMaterializedQueryStatuses() {
    return this._request("GET", `/data/projects/${this.projectId}/materialized-queries/status`);
  }

  refreshMaterializedQuery(queryId) {
    return this._request("POST", `/data/projects/${this.projectId}/materialized-queries/${queryId}/refresh`);
  }

  cancelMaterializedQueryRefresh(queryId) {
    return this._request("POST", `/data/projects/${this.projectId}/materialized-queries/${queryId}/cancel`);
  }

  // ---- Exports ----
  // Async: returns 202 with { id, status: "PENDING" }, NOT 200. Poll getExport.
  createQueryExport(queryId, { format, limit, columns, compression, includeSystemColumns, csvOptions } = {}) {
    return this._request("POST", `/data/projects/${this.projectId}/queries/${queryId}/exports`, {
      body: { format, limit, columns, compression, includeSystemColumns, csvOptions },
    });
  }

  getExport(exportId) {
    return this._request("GET", `/data/projects/${this.projectId}/exports/${exportId}`);
  }

  listExports({ status, limit, createdBefore } = {}) {
    const query = {};
    if (status) query.status = status;
    if (limit) query.limit = limit;
    if (createdBefore) query.createdBefore = createdBefore;
    return this._request("GET", `/data/projects/${this.projectId}/exports`, {
      query: Object.keys(query).length ? query : undefined,
    });
  }

  // Returns 204, not 200. Idempotent.
  cancelExport(exportId) {
    return this._request("DELETE", `/data/projects/${this.projectId}/exports/${exportId}`);
  }

  // ---- Metadata ----
  refreshMetadata({ catalogId, callbackURL, callbackToken }) {
    return this._request("POST", `/metadata/${this.projectId}/refresh`, {
      body: { catalogId, callbackURL, callbackToken },
    });
  }

  // status is one of NOT_ACTIVE/COMPLETED/WAITING/ACTIVE/DELAYED/FAILED/PAUSED/STUCK
  getMetadataRefreshStatus(catalogId) {
    return this._request("GET", `/metadata/${this.projectId}/refresh/${catalogId}`);
  }

  // ---- Peaka internal tables ----
  // Table name goes in the PATH, not the body.
  createInternalTable(tableName) {
    return this._request("POST", `/data/projects/${this.projectId}/table/${tableName}`);
  }

  listInternalTables() {
    return this._request("GET", `/data/projects/${this.projectId}/table`);
  }

  deleteInternalTable(tableName) {
    return this._request("DELETE", `/data/projects/${this.projectId}/table/${tableName}`);
  }

  // Takes an ARRAY of columns; dataType is one of
  // VARCHAR/BIGINT/BOOLEAN/DECIMAL/TIMESTAMP/TIME/DATE/UUID.
  addInternalTableColumns(tableName, columns) {
    return this._request("POST", `/data/projects/${this.projectId}/table/${tableName}/columns`, { body: columns });
  }

  listInternalTableColumns(tableName) {
    return this._request("GET", `/data/projects/${this.projectId}/table/${tableName}/columns`);
  }

  deleteInternalTableColumn(tableName, columnName) {
    return this._request("DELETE", `/data/projects/${this.projectId}/table/${tableName}/columns/${columnName}`);
  }

  // ---- SQL ----
  // Converts Peaka's Trino dialect to a target dialect (mysql, postgres, ...).
  // Project-independent.
  transpileSql(dialect, query) {
    return this._request("POST", `/sql/transpile/${dialect}`, { body: { query } });
  }
}

module.exports = { PeakaClient, BASE_URL };
