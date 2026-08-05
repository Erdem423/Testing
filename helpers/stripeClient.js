/**
 * A deliberately tiny Stripe API client - the ONLY code in this repo that
 * talks to Stripe directly rather than through Peaka.
 *
 * WHY IT EXISTS. Every other test reads whatever Stripe data already exists.
 * Scenario 18 asks a question none of them can: when a row is added at the
 * SOURCE, does a Peaka cache refresh pick it up? Answering that requires
 * writing to Stripe, so this is the one place the suite mutates an upstream
 * system.
 *
 * SCOPE IS INTENTIONALLY MINIMAL - create and delete a customer, nothing else.
 * No SDK dependency: Stripe's REST API takes form-encoded bodies and a bearer
 * token, which `fetch` handles in a few lines. Adding the `stripe` package for
 * two calls would be a large dependency for a small need.
 *
 * SAFETY. The constructor refuses any key that is not `sk_test_`. helpers/env.js
 * already enforces this at load time, but the module that performs the WRITES
 * should not depend on a caller having checked - a live key here would create
 * real customers on a real account.
 *
 * Anything created through this must be tracked on ctx.createdStripeCustomerIds
 * so helpers/cleanup.js removes it. A leftover customer permanently shifts the
 * row counts that scenario C asserts against.
 */

const STRIPE_API = "https://api.stripe.com/v1";

class StripeClient {
  constructor({ token } = {}) {
    const key = token || process.env.STRIPE_TEST_TOKEN;
    if (!key) {
      throw new Error("StripeClient needs STRIPE_TEST_TOKEN");
    }
    if (!key.startsWith("sk_test_")) {
      throw new Error(
        "StripeClient refuses a non-test key. This client CREATES AND DELETES customers - " +
          "pointing it at a live account would mutate real data."
      );
    }
    this.token = key;
  }

  async request(method, path, params) {
    const res = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      // Stripe takes form encoding, not JSON.
      body: params ? new URLSearchParams(params).toString() : undefined,
    });

    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  }

  /** Creates a customer. Track the returned id for cleanup immediately. */
  createCustomer({ name, email }) {
    return this.request("POST", "/customers", { name, email });
  }

  /**
   * Updates an existing customer. Stripe uses POST-to-the-resource for
   * updates, not PUT or PATCH - only the fields passed are changed.
   *
   * Used by o-data-freshness to mutate a row at the source and check the
   * change reaches the cache. Change the EMAIL, not the name: the scenario
   * looks its customer up by name, so the name has to stay a stable key.
   */
  updateCustomer(customerId, fields) {
    return this.request("POST", `/customers/${customerId}`, fields);
  }

  /** Stripe returns { id, deleted: true } on success. */
  deleteCustomer(customerId) {
    return this.request("DELETE", `/customers/${customerId}`);
  }

  /**
   * Finds customers by exact name. Used to sweep leftovers from a crashed run -
   * Stripe has no name filter, so this pages through and matches client-side.
   */
  async findCustomersByNamePrefix(prefix, { limit = 100 } = {}) {
    const res = await this.request("GET", `/customers?limit=${limit}`);
    if (!res.ok || !res.body || !Array.isArray(res.body.data)) return [];
    return res.body.data.filter((c) => typeof c.name === "string" && c.name.startsWith(prefix));
  }
}

module.exports = { StripeClient };
