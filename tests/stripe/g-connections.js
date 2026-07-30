const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * Connection endpoints: create -> list -> get -> update -> delete, plus the
 * connector-config catalogue.
 *
 * Everything here operates on a connection this scenario creates itself and
 * deletes at the end. It must NEVER touch the connection behind
 * PEAKA_CATALOG_ID - the project also contains unrelated pre-existing
 * connections (13 at time of writing), so every assertion looks for OUR
 * connection specifically rather than asserting on list length or contents.
 */
async function runConnections(ctx) {
  const name = `e2e-auto-conn-${ctx.runTag}`;
  let connectionId = null;

  await step("create a connection", async () => {
    const res = await ctx.client.createConnection({
      name,
      type: "stripe",
      credential: { token: ctx.stripeToken },
    });
    assertStatus(res, 200, "createConnection");
    assert(res.body && res.body.id, "Expected a connection id in the response");
    assertEqual(res.body.type, "stripe", "connection type");
    connectionId = res.body.id;
    ctx.createdConnectionIds.push(connectionId);
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
    assertEqual(res.body.type, "stripe", "connection type");
  });

  // SECURITY CHECK. Peaka's reference documents getConnection as returning
  // only id/name/type/url - no credential. This asserts that's actually true,
  // because a connector API leaking the upstream secret back to any caller
  // holding a Peaka key would be a serious problem. Scans the whole serialized
  // body rather than named fields, so it also catches the secret turning up
  // somewhere unexpected.
  await step("connection response never leaks the Stripe key", async () => {
    const res = await ctx.client.getConnection(connectionId);
    assertStatus(res, 200, "getConnection (masking check)");
    const serialized = JSON.stringify(res.body);
    assert(
      !serialized.includes(ctx.stripeToken),
      "getConnection response contains the raw Stripe token - credentials must never be echoed back"
    );
    for (const marker of ["sk_test_", "sk_live_", "rk_test_", "rk_live_"]) {
      assert(
        !serialized.includes(marker),
        `getConnection response contains a '${marker}' prefixed value - looks like an unmasked credential: ${serialized.slice(0, 300)}`
      );
    }
  });

  await step("update the connection's name", async () => {
    const updatedName = `${name}-updated`;
    const res = await ctx.client.updateConnection(connectionId, {
      name: updatedName,
      type: "stripe",
      credential: { token: ctx.stripeToken },
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
    const stripe = res.body.find((c) => c.connectionType === "stripe");
    assert(stripe, "Expected 'stripe' to appear in the supported connector configurations");
  });

  await step("get the stripe connector configuration", async () => {
    const res = await ctx.client.getConnectionConfig("stripe");
    assertStatus(res, 200, "getConnectionConfig(stripe)");
    assertEqual(res.body.connectionType, "stripe", "connectionType");
    assert(res.body.authorizationType, "Expected an authorizationType on the stripe config");
  });

  // Deletion has never been asserted anywhere in this suite - it only
  // happened implicitly in afterAll. This checks it actually took effect.
  await step("delete the connection and confirm it is gone", async () => {
    const res = await ctx.client.deleteConnection(connectionId);
    assertStatus(res, 200, "deleteConnection");
    // Already deleted - drop it from cleanup so afterAll doesn't re-delete
    // and log a spurious warning.
    ctx.createdConnectionIds = ctx.createdConnectionIds.filter((id) => id !== connectionId);

    // DOCS DIVERGENCE (confirmed 2026-07-29): Peaka returns 400, not the 404
    // the reference implies - e.g.
    //   {"error":"INVALID_CONNECTION_ID","message":"invalid connection id","errorCode":"cn004"}
    // The instructor's STRIPE-02 scenario also expects 404 here, so that
    // expectation wouldn't hold against the real API either. What matters is
    // a clean 4xx that names the problem, not a 5xx or a raw stack trace.
    const after = await ctx.client.getConnection(connectionId);
    assertStatusIn(after, [400, 404], "getConnection after delete");
    assert(
      after.body && typeof after.body.message === "string" && after.body.message.length > 0,
      `Expected an explanatory error message for a deleted connection, got: ${JSON.stringify(after.body)}`
    );

    const list = await ctx.client.listConnections();
    assertStatus(list, 200, "listConnections after delete");
    assert(
      !list.body.some((c) => c.id === connectionId),
      "Deleted connection still appears in listConnections"
    );
  });
}

module.exports = { runConnections };
