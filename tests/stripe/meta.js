/**
 * Metadata for this connector folder, read dynamically by server.js when it
 * scans tests/ for subfolders (see server.js's discoverConnectors()).
 *
 * To add a new connector later (Mongo, Supabase, etc.):
 *   1. Create tests/<name>/ with its own test files + a meta.js like this one
 *   2. Create jest/<name>/connector.test.js (see jest/stripe/connector.test.js
 *      as a reference for the pattern - build its own ctx, use
 *      test.concurrent(), afterAll cleanup)
 *   3. That's it - server.js discovers the new folder automatically and it
 *      shows up as a new folder card in the web app. No server.js or
 *      frontend changes needed.
 *
 * `scenarios[].steps` here is just DISPLAY metadata (the dashboard shows
 * these as a static list - it does NOT run them individually or track
 * per-step pass/fail) - it must stay in sync with the actual step("...", ...)
 * calls in this connector's tests/<name>/*.js files (kept as a separate,
 * hand-maintained list rather than derived automatically, since parsing
 * step() calls out of source or introspecting Jest's registered tests
 * without running them isn't straightforward). If you add/remove/rename a
 * step() call in a test file, update the matching entry here too - see the
 * README's "Known gaps" for a real example of this drifting out of sync
 * (`stepCount` used to be wrong for C and F after a step was added and this
 * file wasn't updated).
 */
module.exports = {
  displayName: "Stripe",
  icon: "💳",
  scenarios: [
    {
      name: "A: Connection Setup",
      category: "Connection",
      steps: ["create valid connection", "reject invalid token"],
    },
    {
      name: "B: Catalog & Schema Discovery",
      category: "Discovery",
      steps: [
        "read pre-existing catalog",
        "list schemas",
        "list tables and check core tables present",
        "verify cache capability flags",
        "list columns for 'customers'",
        "list columns for 'charges'",
        "list columns for 'subscriptions'",
        "list columns for 'invoices'",
      ],
    },
    {
      name: "C: Data Correctness",
      category: "Data",
      steps: [
        "resolve catalog name",
        "customer count matches seed",
        "customer count via completed cache",
        "charge outcome distribution roughly matches seed weights",
        "subscription status distribution is sane",
        "invoice count roughly consistent with ~25% of customers",
        "field-level spot check on a specific seeded customer",
      ],
    },
    {
      name: "D: Cache Behavior",
      category: "Cache",
      steps: [
        "select a cache-target table",
        "create a one-time cache on the selected table",
        "cache status eventually reports a completed sync",
        "cache creation on a non-cacheable table fails cleanly",
        "duplicate cache creation on the same table is handled cleanly",
      ],
    },
    {
      name: "F: Error Handling & Edge Cases",
      category: "Errors",
      steps: [
        "resolve catalog name",
        "querying a non-existent table returns a clean error",
        "pagination via limit/offset returns non-overlapping pages",
      ],
    },
  ],
};

