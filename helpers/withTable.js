/**
 * Create -> run -> always delete, for a Peaka Table or Peaka BI Table.
 *
 * Handles what the source doc's own rules require, plus what the live API
 * makes non-trivial:
 *   - rule 3: clean up same-named leftovers at the START of a run, and
 *     always delete in `finally` at the end, even on failure.
 *   - `bitable` strips ALL underscores from table names and silently
 *     collides on the stripped form - creating "e2e_auto_a_b" then
 *     "e2e_auto_ab" both return 200 against the same underlying table (see
 *     helpers/peakaClient.js's createBiTable comment). The leftover sweep
 *     below tries both the literal name and its stripped form, and the
 *     tracked/deleted name is always whatever create() actually returned -
 *     never the name that was sent.
 *
 * @param {object} ctx - a ctx from helpers/buildCtx.js
 * @param {"table"|"bitable"} kind
 * @param {string} name - desired table name (e2e_auto_... by convention)
 * @param {Array<object>} [columns] - column defs to add after create, in the
 *   shape addInternalTableColumns/addBiTableColumns expect
 * @param {(actualName: string, createRes: object) => Promise<any>} fn
 */
async function withTable(ctx, kind, name, columns, fn) {
  const isTable = kind === "table";
  const client = ctx.client;
  const create = isTable ? client.createInternalTable.bind(client) : client.createBiTable.bind(client);
  const del = isTable ? client.deleteInternalTable.bind(client) : client.deleteBiTable.bind(client);
  const addColumns = isTable ? client.addInternalTableColumns.bind(client) : client.addBiTableColumns.bind(client);
  const tracked = isTable ? ctx.createdInternalTableNames : ctx.createdBiTableNames;

  const leftoverCandidates = kind === "bitable" ? [name, name.replace(/_/g, "")] : [name];
  for (const candidate of new Set(leftoverCandidates)) {
    await del(candidate).catch(() => {});
  }

  const createRes = await create(name);
  if (!createRes.ok) {
    throw new Error(`withTable: failed to create ${kind} "${name}": ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  const actualName = (createRes.body && createRes.body.tableName) || name;
  tracked.push(actualName);

  try {
    if (columns && columns.length) {
      const colRes = await addColumns(actualName, columns);
      if (!colRes.ok) {
        throw new Error(
          `withTable: failed to add columns to ${kind} "${actualName}": ${colRes.status} ${JSON.stringify(colRes.body)}`
        );
      }
    }
    return await fn(actualName, createRes);
  } finally {
    await del(actualName).catch(() => {});
    const idx = tracked.indexOf(actualName);
    if (idx !== -1) tracked.splice(idx, 1);
  }
}

module.exports = { withTable };
