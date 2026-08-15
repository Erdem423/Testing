const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");
const { sweepStaleConnections } = require("../../helpers/sweepConnections");

/**
 * PG-E: Connection endpoints - the mirror of Stripe's `G`, and the ONLY
 * scenario in this folder that needs real database credentials.
 *
 * Everything else here reuses the connection behind PEAKA_PG_CATALOG_ID, which
 * is why tests/postgres/config.js can say "only ids, no secrets". This one
 * creates connections from scratch, so it needs PEAKA_PG_URL/PORT/USER/
 * PASSWORD/DATABASE/USE_SSL. It skips cleanly when they are absent - see the
 * `credentials` gate in helpers/preflight.js.
 *
 * IT SWEEPS ITS OWN LEFTOVERS AT THE START, unlike `G`. This is prevention
 * rather than a fix for an observed leak: helpers/cleanup.js only ever deletes
 * what the CURRENT run recorded, so a process killed between creating a
 * connection and reaching afterAll strands it permanently, with nothing able
 * to find it afterwards.
 *
 * That is survivable on a disposable Stripe sandbox. Here a stranded
 * connection holds real database credentials and points at a live database, so
 * the failure mode has to be self-healing rather than unbounded. Sweeping by
 * fixed name prefix at the start - the pattern tests/peaka-tables/ uses - turns
 * "leaks forever" into "cleaned up on the next run".
 *
 * (For the record: 11 orphaned `test-stripe-conn-*` connections do sit in this
 * project, dated 21-30 July 2026, but they predate the current `e2e-auto-`
 * naming and no code creates that name any more. They are historical debris,
 * not proof that `G` leaks today - `G` cleans up correctly.)
 *
 * CREDENTIALS ARE NEVER LOGGED. Assertions scan for the password rather than
 * printing anything that might contain it, and the failure messages below
 * deliberately quote only response metadata.
 *
 * SUPABASE NOTE: the direct-connection host (db.<ref>.supabase.co) is
 * IPv6-only on the free tier, and Peaka cannot reach it - createConnection
 * returns 400 INVALID_CREDENTIALS carrying just the hostname. The session
 * pooler host (aws-N-<region>.pooler.supabase.com, user postgres.<ref>) works.
 * Measured 2026-08-07; worth knowing before debugging a rejection that looks
 * like a wrong password.
 */

// Fixed prefix, no runTag, so the sweep below can find leftovers from a run
// that never reached its cleanup.
const NAME_PREFIX = "e2e-auto-pg-conn";

function credentialFromEnv() {
  return {
    url: process.env.PEAKA_PG_URL,
    port: Number(process.env.PEAKA_PG_PORT),
    user: process.env.PEAKA_PG_USER,
    password: process.env.PEAKA_PG_PASSWORD,
    databaseName: process.env.PEAKA_PG_DATABASE,
    useSsl: String(process.env.PEAKA_PG_USE_SSL).toLowerCase() === "true",
  };
}

async function runPgConnections(ctx) {
  const name = `${NAME_PREFIX}-${ctx.runTag}`;
  const password = process.env.PEAKA_PG_PASSWORD;
  let connectionId = null;

  // Age-guarded: these names embed runTag, so a bare prefix match would delete
  // a LIVE connection belonging to a concurrent run - two people against one
  // project, or CI overlapping a local run. See helpers/sweepConnections.js.
  await step("sweep leftover connections from crashed runs", async () => {
    await sweepStaleConnections(ctx, NAME_PREFIX, (line) => console.log(line));
  });

  await step("create a connection", async () => {
    const res = await ctx.client.createConnection({ name, type: "POSTGRES", credential: credentialFromEnv() });
    assertStatus(res, 200, "createConnection(POSTGRES)");
    assert(res.body && res.body.id, "Expected a connection id in the response");
    assertEqual(res.body.type, "POSTGRES", "connection type");
    connectionId = res.body.id;
    ctx.createdConnectionIds.push(connectionId);
  });

  // The connection is only meaningful if it actually reaches the database - a
  // 200 from createConnection alone would also be returned by a connector that
  // stored the credentials without ever testing them.
  await step("the connection actually reaches the database", async () => {
    const cat = await ctx.client.createCatalog({ name, connectionId });
    assertStatus(cat, 200, "createCatalog (over the new connection)");
    ctx.createdCatalogIds.push(cat.body.id);

    const schemas = await ctx.client.listSchemas(cat.body.id);
    assertStatus(schemas, 200, "listSchemas (over the new connection)");
    assert(
      Array.isArray(schemas.body) && schemas.body.length > 0,
      `Expected schemas through the new connection, got: ${JSON.stringify(schemas.body).slice(0, 200)}`
    );
    const names = schemas.body.map((s) => s.schemaName);
    assert(
      names.includes(ctx.schemaName),
      `Expected the configured schema '${ctx.schemaName}' through the new connection. Got: ${names.join(", ")}`
    );
    console.log(`reached the database: ${names.length} schemas visible`);
  });

  // ALL FIVE REJECTIONS MEASURED 2026-08-07 before being asserted. The
  // distinction between them is real and worth pinning: a credential that is
  // present but wrong is rejected by credential validation (INVALID_CREDENTIALS),
  // while a MISSING credential is rejected earlier by schema validation
  // (Bad Request). A connector collapsing those into one generic error would
  // be materially harder to diagnose against.
  await step("invalid credentials are rejected, never silently accepted", async () => {
    const base = credentialFromEnv();
    const attempts = [
      { label: "wrong password", credential: { ...base, password: "definitely_not_the_password" }, expect: "INVALID_CREDENTIALS" },
      { label: "unreachable port", credential: { ...base, port: 9999 }, expect: "INVALID_CREDENTIALS" },
      { label: "empty credential object", credential: {}, expect: "INVALID_CREDENTIALS" },
      { label: "password field missing", credential: { ...base, password: undefined }, expect: "INVALID_CREDENTIALS" },
    ];

    for (const attempt of attempts) {
      const res = await ctx.client.createConnection({
        name: `${NAME_PREFIX}-bad-${ctx.runTag}`,
        type: "POSTGRES",
        credential: attempt.credential,
      });

      // Defensive: if Peaka ever starts accepting these, the connection is real
      // and must be cleaned up. Tracked before asserting so a failure cannot
      // strand a connection pointing at a live database.
      if (res.status === 200 && res.body && res.body.id) ctx.createdConnectionIds.push(res.body.id);

      assertStatus(res, 400, `createConnection with ${attempt.label}`);
      assertEqual(res.body.error, attempt.expect, `error code for ${attempt.label}`);
      console.log(`  ${attempt.label} -> 400 ${res.body.error}`);
    }

    // Omitting `credential` entirely fails schema validation instead, one layer
    // earlier - a different error shape, deliberately asserted separately.
    const omitted = await ctx.client.createConnection({ name: `${NAME_PREFIX}-bad-${ctx.runTag}`, type: "POSTGRES" });
    if (omitted.status === 200 && omitted.body && omitted.body.id) ctx.createdConnectionIds.push(omitted.body.id);
    assertStatus(omitted, 400, "createConnection with credential omitted entirely");
    assertEqual(omitted.body.error, "Bad Request", "error code for an omitted credential");
    console.log(`  credential omitted -> 400 ${omitted.body.error}`);
  });

  // SECURITY. A rejection message is a classic place for a credential to leak,
  // because error paths are written in a hurry and rarely reviewed. Peaka's
  // wrong-password response quotes the failing USERNAME
  // ("FATAL: password authentication failed for user ...") and its schema
  // errors echo the submitted JSON back - so the password travelling in that
  // same object genuinely could surface here.
  await step("error messages never echo the password", async () => {
    const base = credentialFromEnv();
    const probes = [
      { label: "wrong password", credential: { ...base, password: "wrong_password_probe" } },
      { label: "unreachable port", credential: { ...base, port: 9999 } },
    ];
    for (const probe of probes) {
      const res = await ctx.client.createConnection({
        name: `${NAME_PREFIX}-leak-${ctx.runTag}`,
        type: "POSTGRES",
        credential: probe.credential,
      });
      if (res.status === 200 && res.body && res.body.id) ctx.createdConnectionIds.push(res.body.id);
      const serialized = JSON.stringify(res.body);
      assert(
        !serialized.includes(password),
        `The rejection message for '${probe.label}' contains the real database password. ` +
          `Error responses must never echo credentials. (Message not reproduced here for obvious reasons.)`
      );
    }
    console.log("  rejection messages carry no password");
  });

  await step("list connections includes the new one", async () => {
    const res = await ctx.client.listConnections();
    assertStatus(res, 200, "listConnections");
    assert(Array.isArray(res.body), "Expected an array of connections");
    const found = res.body.find((c) => c.id === connectionId);
    assert(found, `Newly created connection ${connectionId} not found in listConnections (${res.body.length} returned)`);
    assertEqual(found.name, name, "listed connection name");
  });

  await step("get connection returns its metadata", async () => {
    const res = await ctx.client.getConnection(connectionId);
    assertStatus(res, 200, "getConnection");
    assertEqual(res.body.id, connectionId, "connection id");
    assertEqual(res.body.type, "POSTGRES", "connection type");
  });

  // SECURITY. The Stripe equivalent scans for `sk_test_`-style markers; a
  // database password has no recognisable prefix, so this scans for the real
  // value plus the other connection fields that would indicate the whole
  // credential object being echoed back.
  await step("connection responses never leak the database password", async () => {
    for (const [label, res] of [
      ["getConnection", await ctx.client.getConnection(connectionId)],
      ["getConnectionDetail", await ctx.client.getConnectionDetail(connectionId)],
    ]) {
      assertStatus(res, 200, `${label} (masking check)`);
      const serialized = JSON.stringify(res.body);
      assert(
        !serialized.includes(password),
        `${label} returned the raw database password - credentials must never be echoed back to a caller ` +
          `holding only a Peaka API key.`
      );
      assert(
        !/"password"\s*:/i.test(serialized),
        `${label} response contains a 'password' field: ${serialized.slice(0, 200)}`
      );
    }
    console.log("  password absent from both getConnection and getConnectionDetail");
  });

  await step("update the connection's name", async () => {
    const updatedName = `${name}-updated`;
    const res = await ctx.client.updateConnection(connectionId, {
      name: updatedName,
      type: "POSTGRES",
      credential: credentialFromEnv(),
    });
    assertStatus(res, 200, "updateConnection");

    const after = await ctx.client.getConnection(connectionId);
    assertStatus(after, 200, "getConnection after update");
    assertEqual(after.body.name, updatedName, "connection name after update");
  });

  await step("the POSTGRES connector configuration is published", async () => {
    const list = await ctx.client.listConnectionConfig();
    assertStatus(list, 200, "listConnectionConfig");
    assert(Array.isArray(list.body) && list.body.length > 0, "Expected a non-empty connector config list");
    assert(
      list.body.some((c) => c.connectionType === "POSTGRES"),
      "Expected 'POSTGRES' to appear in the supported connector configurations"
    );

    const cfg = await ctx.client.getConnectionConfig("POSTGRES");
    assertStatus(cfg, 200, "getConnectionConfig(POSTGRES)");
    assertEqual(cfg.body.connectionType, "POSTGRES", "connectionType");

    // The six fields this scenario's .env block mirrors. Asserted so that a
    // connector gaining or renaming a required field shows up here rather than
    // as a confusing INVALID_CREDENTIALS at connection time.
    const fields = (cfg.body.configuration || []).map((f) => f.fieldName);
    for (const expected of ["url", "port", "user", "password", "databaseName", "useSsl"]) {
      assert(
        fields.includes(expected),
        `The POSTGRES connector config no longer lists a '${expected}' field. Fields: ${fields.join(", ")}. ` +
          `The .env block documented in the README needs updating to match.`
      );
    }
    console.log(`  POSTGRES config requires: ${fields.join(", ")}`);
  });

  await step("delete the connection and confirm it is gone", async () => {
    // The catalog depends on the connection, so it goes first.
    for (const catalogId of [...ctx.createdCatalogIds]) {
      const del = await ctx.client.deleteCatalog(catalogId);
      assertStatusIn(del, [200, 204], `deleteCatalog(${catalogId})`);
      ctx.createdCatalogIds = ctx.createdCatalogIds.filter((id) => id !== catalogId);
    }

    const res = await ctx.client.deleteConnection(connectionId);
    assertStatus(res, 200, "deleteConnection");
    ctx.createdConnectionIds = ctx.createdConnectionIds.filter((id) => id !== connectionId);

    // DOCS DIVERGENCE, same as Stripe's G: Peaka returns 400, not the 404 the
    // reference implies. What matters is a clean 4xx naming the problem.
    const after = await ctx.client.getConnection(connectionId);
    assertStatusIn(after, [400, 404], "getConnection after delete");
    assert(
      after.body && typeof after.body.message === "string" && after.body.message.length > 0,
      `Expected an explanatory error for a deleted connection, got: ${JSON.stringify(after.body)}`
    );

    const list = await ctx.client.listConnections();
    assertStatus(list, 200, "listConnections after delete");
    assert(!list.body.some((c) => c.id === connectionId), "Deleted connection still appears in listConnections");
  });
}

module.exports = { runPgConnections };
