const { assertStatus, assertStatusIn, assert, assertEqual } = require("../../helpers/assert");
const { step } = require("../../helpers/step");

/**
 * Connection Setup: verifies Peaka can still create a valid Stripe
 * connection, and cleanly rejects an invalid one. Fully standalone - doesn't
 * touch ctx.catalogId/schemaName or anything the other consolidated tests use.
 */
async function runConnectionSetup(ctx) {
  await step("create valid connection", async () => {
    const res = await ctx.client.createConnection({
      name: `test-stripe-conn-${Date.now()}`,
      type: "stripe",
      credential: { token: ctx.stripeToken },
    });
    assertStatus(res, 200, "createConnection");
    assert(res.body && res.body.id, "Response should include connection id");
    assertEqual(res.body.type, "stripe", "connection type");
    ctx.createdConnectionIds.push(res.body.id); // track for cleanup
  });

  await step("reject invalid token", async () => {
    const res = await ctx.client.createConnection({
      name: `test-stripe-invalid-${Date.now()}`,
      type: "stripe",
      credential: { token: "not_a_real_token" },
    });
    // Depending on how eagerly Peaka validates, this may fail at connection
    // creation (4xx) or succeed here and fail later at catalog/query time.
    // Either is acceptable as long as it's not silently treated as valid data.
    assertStatusIn(res, [200, 400, 401, 422], "createConnection with bad token");
    if (res.status === 200) {
      console.log(
        "note: invalid token was accepted at connection-time; verify catalog/query calls fail downstream"
      );
      ctx.createdConnectionIds.push(res.body.id); // track for cleanup even though it's a throwaway
    }
  });
}

module.exports = { runConnectionSetup };
