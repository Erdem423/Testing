/**
 * Deletes everything a test run created, in dependency order:
 * cache -> catalog -> connection (a catalog can't be deleted while a cache
 * depends on it; a connection can't be deleted while a catalog depends on it).
 *
 * Best-effort: deleteCache/deleteCatalog/deleteConnection paths are inferred
 * from REST convention (see peakaClient.js header) and not yet confirmed
 * against Peaka's docs, so failures here are reported per-item rather than
 * thrown - a cleanup failure shouldn't mask real test results.
 *
 * @param {object} ctx - the shared run context (client, createdCacheIds, etc.)
 * @param {(line: string) => void} [log] - called with each human-readable
 *   progress line (defaults to console.log; the web server passes something
 *   that streams to the browser instead).
 * @returns {Promise<Array<{type: string, id: string, ok: boolean, status?: number, error?: string}>>}
 */
async function cleanup(ctx, log = console.log) {
  const outcomes = [];

  for (const cacheId of [...ctx.createdCacheIds].reverse()) {
    try {
      const res = await ctx.client.deleteCache(cacheId);
      if (res.ok) {
        log(`✓ Deleted cache ${cacheId}`);
        outcomes.push({ type: "cache", id: cacheId, ok: true });
      } else {
        log(`⚠ Could not delete cache ${cacheId} (status ${res.status}) - may need manual cleanup`);
        outcomes.push({ type: "cache", id: cacheId, ok: false, status: res.status });
      }
    } catch (err) {
      log(`⚠ Error deleting cache ${cacheId}: ${err.message}`);
      outcomes.push({ type: "cache", id: cacheId, ok: false, error: err.message });
    }
  }

  for (const catalogId of [...ctx.createdCatalogIds].reverse()) {
    try {
      const res = await ctx.client.deleteCatalog(catalogId);
      if (res.ok) {
        log(`✓ Deleted catalog ${catalogId}`);
        outcomes.push({ type: "catalog", id: catalogId, ok: true });
      } else {
        log(`⚠ Could not delete catalog ${catalogId} (status ${res.status}) - may need manual cleanup`);
        outcomes.push({ type: "catalog", id: catalogId, ok: false, status: res.status });
      }
    } catch (err) {
      log(`⚠ Error deleting catalog ${catalogId}: ${err.message}`);
      outcomes.push({ type: "catalog", id: catalogId, ok: false, error: err.message });
    }
  }

  for (const connectionId of [...ctx.createdConnectionIds].reverse()) {
    try {
      const res = await ctx.client.deleteConnection(connectionId);
      if (res.ok) {
        log(`✓ Deleted connection ${connectionId}`);
        outcomes.push({ type: "connection", id: connectionId, ok: true });
      } else {
        log(`⚠ Could not delete connection ${connectionId} (status ${res.status}) - may need manual cleanup`);
        outcomes.push({ type: "connection", id: connectionId, ok: false, status: res.status });
      }
    } catch (err) {
      log(`⚠ Error deleting connection ${connectionId}: ${err.message}`);
      outcomes.push({ type: "connection", id: connectionId, ok: false, error: err.message });
    }
  }

  return outcomes;
}

module.exports = { cleanup };
