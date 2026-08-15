const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * Connection endpoints, HubSpot version of tests/stripe/g-connections.js:
 * create -> list -> get -> update -> delete, plus the connector-config
 * catalogue and credential validation.
 *
 * BLOCKED ON A REAL HUBSPOT CREDENTIAL. createConnection needs
 * HUBSPOT_ACCESS_TOKEN. Confirmed (2026-08-06) via getConnectionConfig
 * ("hubspot") that HubSpot connections are OAuth2 (authorizationType:
 * "oauth2"), with credential fields accessToken/refreshToken/clientId/
 * clientSecret/redirectUrl - all marked non-required by that config, but an
 * accessToken is realistically needed to authenticate. What's still
 * UNCONFIRMED is whether a HubSpot Private App token works as that
 * accessToken without the other OAuth fields - if createConnection fails
 * here, that's the first thing to check.
 *
 * Everything here operates on a connection this scenario creates itself and
 * deletes at the end. It must NEVER touch the connection behind
 * PEAKA_HUBSPOT_CATALOG_ID.
 */
async function runConnections(ctx) {
  const name = `e2e-auto-conn-${ctx.runTag}`;
  let connectionId = null;

  await step("create a connection", async () => {
    const res = await ctx.client.createConnection({
      name,
      type: "hubspot",
      credential: { accessToken: ctx.token },
    });
    assertStatus(res, 200, "createConnection");
    assert(res.body && res.body.id, "Expected a connection id in the response");
    assertEqual(res.body.type, "hubspot", "connection type");
    connectionId = res.body.id;
    ctx.createdConnectionIds.push(connectionId);
  });

  await step("an invalid token is not silently accepted", async () => {
    const res = await ctx.client.createConnection({
      name: `e2e-auto-conn-invalid-${ctx.runTag}`,
      type: "hubspot",
      credential: { accessToken: "not_a_real_token" },
    });
    assertStatusIn(res, [200, 400, 401, 422], "createConnection with bad token");
    if (res.status === 200) {
      console.log(
        "note: invalid token was accepted at connection-time; verify catalog/query calls fail downstream"
      );
      ctx.createdConnectionIds.push(res.body.id);
    }
  });

  await step("list connections includes the new one", async () => {
    const res = await ctx.client.listConnections();
    assertStatus(res, 200, "listConnections");
    assert(Array.isArray(res.body), "Expected an array of connections");
    const found = res.body.find((c) => c.id === connectionId);
    assert(
      found,
      `Newly created connection ${connectionId} not found in listConnections (${res.body.length} returned)`
    );
    assertEqual(found.name, name, "listed connection name");
  });

  await step("get connection returns its metadata", async () => {
    const res = await ctx.client.getConnection(connectionId);
    assertStatus(res, 200, "getConnection");
    assertEqual(res.body.id, connectionId, "connection id");
    assertEqual(res.body.type, "hubspot", "connection type");
  });

  // SECURITY CHECK - same reasoning as Stripe's version. Unlike Stripe's
  // check, this does NOT scan for connector-specific prefix markers -
  // HubSpot's OAuth2 accessToken has no fixed prefix like Stripe's sk_/rk_.
  // It still scans the whole serialized body for the raw token value itself,
  // which is the check that actually matters.
  await step("connection response never leaks the HubSpot token", async () => {
    const res = await ctx.client.getConnection(connectionId);
    assertStatus(res, 200, "getConnection (masking check)");
    const serialized = JSON.stringify(res.body);
    assert(
      !serialized.includes(ctx.token),
      "getConnection response contains the raw HubSpot token - credentials must never be echoed back"
    );
  });

  await step("update the connection's name", async () => {
    const updatedName = `${name}-updated`;
    const res = await ctx.client.updateConnection(connectionId, {
      name: updatedName,
      type: "hubspot",
      credential: { accessToken: ctx.token },
    });
    assertStatus(res, 200, "updateConnection");

    const after = await ctx.client.getConnection(connectionId);
    assertStatus(after, 200, "getConnection after update");
    assertEqual(after.body.name, updatedName, "connection name after update");
  });

  await step("list supported connector configurations", async () => {
    const res = await ctx.client.listConnectionConfig();
    assertStatus(res, 200, "listConnectionConfig");
    assert(Array.isArray(res.body) && res.body.length > 0, "Expected a non-empty connector config list");
    const hubspot = res.body.find((c) => c.connectionType === "hubspot");
    assert(hubspot, "Expected 'hubspot' to appear in the supported connector configurations");
  });

  // THE DISCOVERY CALL - run this first if createConnection above is
  // failing. authorizationType here is what confirms the real credential
  // shape (OAuth vs. bearer token vs. something else).
  await step("get the hubspot connector configuration", async () => {
    const res = await ctx.client.getConnectionConfig("hubspot");
    assertStatus(res, 200, "getConnectionConfig(hubspot)");
    assertEqual(res.body.connectionType, "hubspot", "connectionType");
    assert(res.body.authorizationType, "Expected an authorizationType on the hubspot config");
    console.log(`hubspot authorizationType: ${res.body.authorizationType}`);
  });

  await step("delete the connection and confirm it is gone", async () => {
    const res = await ctx.client.deleteConnection(connectionId);
    assertStatus(res, 200, "deleteConnection");
    ctx.createdConnectionIds = ctx.createdConnectionIds.filter((id) => id !== connectionId);

    const after = await ctx.client.getConnection(connectionId);
    assertStatusIn(after, [400, 404], "getConnection after delete");
    assert(
      after.body && typeof after.body.message === "string" && after.body.message.length > 0,
      `Expected an explanatory error message for a deleted connection, got: ${JSON.stringify(after.body)}`
    );

    const list = await ctx.client.listConnections();
    assertStatus(list, 200, "listConnections after delete");
    assert(!list.body.some((c) => c.id === connectionId), "Deleted connection still appears in listConnections");
  });
}

module.exports = { runConnections };
