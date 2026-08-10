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

  // `formData` sends a multipart/form-data body (FormData) instead of JSON -
  // used only by createTableImport. Content-Type is deliberately OMITTED in
  // that case: fetch sets its own `multipart/form-data; boundary=...` header,
  // and hand-setting application/json (what every other call needs) would
  // silently corrupt the upload.
  async _request(method, path, { body, query, formData } = {}) {
    let url = `${BASE_URL}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      url += `?${qs}`;
    }

    const headers = { Authorization: `Bearer ${this.apiKey}` };
    if (!formData) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: formData || (body ? JSON.stringify(body) : undefined),
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

  // Returns LESS than getConnection, not more, despite the name: measured
  // 2026-08-04 it gives `{ type }` alone, where getConnection gives
  // id/name/type/url. Path verified by probe - `/details` and the
  // project-scoped forms all return the generic framework 404.
  getConnectionDetail(connectionId) {
    return this._request("GET", `/connections/${this.projectId}/${connectionId}/detail`);
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
  // SELECT-ONLY. Verified 2026-08-06: INSERT/UPDATE/DELETE/CREATE TABLE AS
  // SELECT all return 400 "Statement type 'X' is not allowed" - there is no
  // DML path through this endpoint. The only write path into a Peaka Table
  // is createTableImport (CSV). Peaka BI Table has no known write path at
  // all - see the "Peaka internal tables" comment block below.
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

  // ---- Query paths and folders ----
  //
  // PATCH, NOT the documented PUT. The reference gives
  // `PUT /api/queries/{queryId}/path`; both parts of that are wrong against the
  // live API. Verified 2026-08-03 by calling each candidate with a well-formed
  // but non-existent query id and comparing against a deliberate nonsense
  // control:
  //     /api/queries/{id}/path            -> 404, same shape as the control
  //     .../queries/{id}/path via PUT     -> 405 Method Not Allowed
  //     .../queries/{id}/path via POST    -> 405 Method Not Allowed
  //     .../queries/{id}/path via PATCH   -> reached the handler
  // The 405s are what identified the route as real but the verb as wrong.
  //
  // Moving a query to a path that does not exist CREATES a folder, and that
  // folder OUTLIVES the query - deleting the query leaves it behind. Anything
  // calling this must track the folder for cleanup; see helpers/cleanup.js.
  updateQueryPath(queryId, path) {
    return this._request("PATCH", `/data/projects/${this.projectId}/queries/${queryId}/path`, {
      body: { path },
    });
  }

  // Returns { items: [{ id, name, path, parentId, createdAt, ... }] } - note
  // the envelope, unlike the bare arrays most list endpoints return.
  listQueryFolders() {
    return this._request("GET", `/data/projects/${this.projectId}/queries/folders`);
  }

  // 204 on success.
  deleteQueryFolder(folderId) {
    return this._request("DELETE", `/data/projects/${this.projectId}/queries/folders/${folderId}`);
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

  // Exports a TABLE directly, rather than a saved query. Path verified against
  // the live API 2026-08-04 - the reference abbreviates it, and three of the
  // four candidates returned the generic framework 404.
  //
  // Two behaviours worth knowing, both measured:
  //   - The 100-row cap applies. Exporting the 652-row `charges` table produces
  //     a file with rowCount 100, with no error and no indication.
  //   - Exporting an EMPTY table FAILS rather than producing an empty file:
  //     "Trino-native export produced no files at s3a://export/...".
  createTableExport(catalogId, schemaName, tableName, { format, limit, columns, compression } = {}) {
    return this._request(
      "POST",
      `/data/projects/${this.projectId}/catalogs/${catalogId}/schemas/${schemaName}/tables/${tableName}/exports`,
      { body: { format, limit, columns, compression } }
    );
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
  //
  // NO JSON TYPE, contrary to the source doc's own claim that Peaka Table
  // (unlike BI Table) supports JSON columns. Verified 2026-08-06:
  // dataType: "JSON" is rejected here exactly as it is for addBiTableColumns
  // - 400 "No enum constant com.peaka.gateway.model.ColumnRequest.ColumnType.JSON".
  // The live server's column-type enum has no JSON member for EITHER table
  // kind. This blocks PT-03/PT-10 in the source doc as literally specified.
  //
  // Every table also carries SYSTEM COLUMNS you never declared - observed:
  // _id (bigint, default abstract_schema_mapper.next_id()), _version, and
  // _created_time. A "columns match exactly what I added" assertion must
  // filter these out rather than expecting an exact-length match.
  addInternalTableColumns(tableName, columns) {
    return this._request("POST", `/data/projects/${this.projectId}/table/${tableName}/columns`, { body: columns });
  }

  listInternalTableColumns(tableName) {
    return this._request("GET", `/data/projects/${this.projectId}/table/${tableName}/columns`);
  }

  deleteInternalTableColumn(tableName, columnName) {
    return this._request("DELETE", `/data/projects/${this.projectId}/table/${tableName}/columns/${columnName}`);
  }

  // Multipart upload: `file` is a CSV string, `mappings` is
  // [{ name, csvColumnName }] (or csvColumnIndex when containsHeader is
  // false - csvColumnName is then rejected). Table name in the path, as with
  // create/delete above.
  //
  // CONSTRAINTS ARE NOT ENFORCED ON IMPORT. Verified 2026-08-06: a table with
  // an isUnique/isNotNull column happily imports two duplicate values -
  // "processed": 2, COUNT(*) afterwards is 2. isNotNull/isUnique/defaultValue
  // are accepted at column-creation time but not checked here, and there is
  // no other write path to test them against - see PT-09 in the source doc.
  createTableImport(tableName, { file, mappings, containsHeader = true }) {
    const fd = new FormData();
    fd.append("file", new Blob([file], { type: "text/csv" }), "import.csv");
    fd.append("request", JSON.stringify({ mappings, containsHeader }));
    return this._request("POST", `/data/projects/${this.projectId}/table/${tableName}/import`, { formData: fd });
  }

  // Returns `Content-Type: text/csv`, but note: _request's JSON-only parsing
  // (res.json()) can't read it - callers wanting the actual CSV need a raw
  // fetch of this path, not this method's `.body`.
  //
  // NOT WHAT ITS NAME SUGGESTS. Verified 2026-08-06 with a raw-text fetch:
  // this returns a CANNED TEMPLATE, unrelated to the real table.
  //   - A NONEXISTENT table: 200, body is five blank lines ("\n\n\n\n\n").
  //   - A real table with declared columns (name, age): 200, but the header
  //     is "text,name,age" - a "text" column that was never declared - and
  //     every row is "sample text","sample text",<random int>.
  //   - The SAME table AFTER importing real rows (alice/30, bob/40): still
  //     the exact same synthetic "sample text"/random-int pattern. Real data
  //     never appears.
  // So this does not reflect the table's actual columns or content in any
  // observed case - it looks like a fixed example generator, keyed on
  // nothing we varied. PT-13 in the source doc expects real column names as
  // the header; that expectation does not hold as observed.
  getTableSample(tableName) {
    return this._request("GET", `/data/projects/${this.projectId}/table/${tableName}/sample`);
  }

  // Requires the FULL column body, not a partial patch - verified 2026-08-06.
  // Sending only { displayName } fails: 400 "Class discriminator was missing
  // ... polymorphic scope of 'SerColumnType'" (dataType is the discriminator
  // and is required even though it isn't changing). Send the complete shape:
  // { name, dataType, displayName, defaultValue, isNotNull, isUnique }.
  updateInternalTableColumn(tableName, columnName, column) {
    return this._request("PUT", `/data/projects/${this.projectId}/table/${tableName}/columns/${columnName}`, {
      body: column,
    });
  }

  // ---- Peaka BI Table (bitable) ----
  // Same shape as Peaka Table above, under /bitable/ instead of /table/, with
  // real differences measured 2026-08-06:
  //   - No JSON column type - same as Peaka Table, see addInternalTableColumns.
  //   - No import/sample routes exist at all (both generic 404 - confirmed
  //     both ad hoc and again as part of this suite's Phase A probes).
  //   - No row-level write endpoint of ANY kind was found (also probed
  //     /rows, /data, /records, /insert, /values - all generic 404). As of
  //     this writing there is no known way to put data into a BI Table
  //     through the Partner API.
  //   - create() silently STRIPS ALL UNDERSCORES from the table name -
  //     "e2e_test_underscore_probe" is stored as "e2etestunderscoreprobe".
  //     Peaka Table preserves the name unchanged. Always track/delete the
  //     NAME THE RESPONSE RETURNS, never the name you sent - see
  //     helpers/withTable.js.
  //   - THIS CAUSES REAL COLLISIONS, not just cosmetic renaming: creating
  //     "e2e_auto_a_b" then "e2e_auto_ab" both return 200 with the identical
  //     tableName ("eautoab"). The second create does not error as a
  //     duplicate - it silently succeeds against the same underlying table.
  //     Two scenario names that differ only by underscore placement are the
  //     same table.
  createBiTable(tableName) {
    return this._request("POST", `/data/projects/${this.projectId}/bitable/${tableName}`);
  }

  listBiTables() {
    return this._request("GET", `/data/projects/${this.projectId}/bitable`);
  }

  deleteBiTable(tableName) {
    return this._request("DELETE", `/data/projects/${this.projectId}/bitable/${tableName}`);
  }

  // Same shape as addInternalTableColumns, minus JSON: a JSON dataType is
  // rejected with 400 "No enum constant
  // com.peaka.gateway.model.ColumnRequest.ColumnType.JSON" - functionally
  // correct per the docs, but the message leaks an internal Java class name
  // to the API consumer.
  //
  // TWO SEPARATE BUGS HERE, verified independent 2026-08-06 - don't
  // conflate them:
  //
  // (1) COLUMN NAMES ARE STRIPPED OF UNDERSCORES, exactly like table names:
  //     "col_a" is stored as "cola". Only fires when the name actually
  //     contains an underscore - "status" stays "status".
  //
  // (2) displayName IS ALWAYS OVERWRITTEN with the column's own name,
  //     whatever that name ends up being. This fires REGARDLESS of
  //     underscores: a column named "flag" sent with displayName
  //     "Flag Label" stores displayName "flag". Bug (1) is not involved -
  //     it just mangles the name first when one has underscores, which is
  //     what makes the two look like one bug.
  //
  // Both are universal across all 8 supported types (VARCHAR/BIGINT/
  // BOOLEAN/DECIMAL/TIMESTAMP/DATE/UUID/TIME) - not a VARCHAR quirk.
  // Peaka Table's addInternalTableColumns respects displayName correctly
  // for the same column names and values, so this is BI-Table-specific.
  //
  // Every BI Table also carries MORE system columns than Peaka Table:
  // _id, _version, _created_time, _created_by, _last_modified_time,
  // _last_modified_by, _session, _operation, and a non-underscored "text"
  // column that appears to be a default/example column, not something you
  // declared. Filter these out of any "columns match what I added" check.
  addBiTableColumns(tableName, columns) {
    return this._request("POST", `/data/projects/${this.projectId}/bitable/${tableName}/columns`, { body: columns });
  }

  listBiTableColumns(tableName) {
    return this._request("GET", `/data/projects/${this.projectId}/bitable/${tableName}/columns`);
  }

  // Verified working normally - deleted column disappears from the list and
  // SELECT of it 4xxs with a clear "cannot be resolved" message. Unaffected
  // by the displayName issue below.
  deleteBiTableColumn(tableName, columnName) {
    return this._request("DELETE", `/data/projects/${this.projectId}/bitable/${tableName}/columns/${columnName}`);
  }

  // Same full-body requirement as updateInternalTableColumn - see its
  // comment. BUT THE DISPLAYNAME CHANGE DOES NOT PERSIST, verified
  // 2026-08-06 (checked again after a 3s wait, ruling out propagation lag,
  // and again across all 8 column types - universal, not type-specific):
  // this returns 200 with a response body that ECHOES the requested
  // displayName as if it worked, but a subsequent listBiTableColumns still
  // shows the old value. The response lies about what happened. Peaka
  // Table's updateInternalTableColumn genuinely persists - this is
  // BI-Table-specific.
  updateBiTableColumn(tableName, columnName, column) {
    return this._request("PUT", `/data/projects/${this.projectId}/bitable/${tableName}/columns/${columnName}`, {
      body: column,
    });
  }

  // ---- SQL ----
  // Converts Peaka's Trino dialect to a target dialect (mysql, postgres, ...).
  // Project-independent.
  transpileSql(dialect, query) {
    return this._request("POST", `/sql/transpile/${dialect}`, { body: { query } });
  }
}

module.exports = { PeakaClient, BASE_URL };
