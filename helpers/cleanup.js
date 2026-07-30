/**
 * Deletes everything a test run created, in dependency order:
 * cache -> query -> internal table -> catalog -> connection. A catalog can't
 * be deleted while a cache depends on it, and a connection can't be deleted
 * while a catalog depends on it.
 *
 * Best-effort by design: every deletion is reported per-item rather than
 * thrown, so a cleanup failure never masks a real test result.
 *
 * IMPORTANT: this only ever deletes ids the run itself recorded. It must
 * never touch PEAKA_CATALOG_ID or the connection behind it - that's the
 * user's real, hand-provisioned catalog, and the project also contains
 * unrelated pre-existing connections/queries/tables.
 *
 * @param {object} ctx - the shared run context (client, createdCacheIds, etc.)
 * @param {(line: string) => void} [log] - called with each human-readable
 *   progress line (defaults to console.log; the web server passes something
 *   that streams to the browser instead).
 * @returns {Promise<Array<{type: string, id: string, ok: boolean, status?: number, error?: string}>>}
 */
async function cleanup(ctx, log = console.log) {
  const outcomes = [];

  /** Shared per-item deletion with uniform logging and error capture. */
  async function deleteEach(ids, type, deleteFn) {
    for (const id of [...(ids || [])].reverse()) {
      try {
        const res = await deleteFn(id);
        if (res.ok) {
          log(`✓ Deleted ${type} ${id}`);
          outcomes.push({ type, id, ok: true });
        } else {
          log(`⚠ Could not delete ${type} ${id} (status ${res.status}) - may need manual cleanup`);
          outcomes.push({ type, id, ok: false, status: res.status });
        }
      } catch (err) {
        log(`⚠ Error deleting ${type} ${id}: ${err.message}`);
        outcomes.push({ type, id, ok: false, error: err.message });
      }
    }
  }

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

  await deleteEach(ctx.createdQueryIds, "query", (id) => ctx.client.deleteQuery(id));
  await deleteEach(ctx.createdInternalTableNames, "internal table", (n) => ctx.client.deleteInternalTable(n));

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
