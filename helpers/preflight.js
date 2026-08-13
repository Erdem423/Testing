const fs = require("fs");
const path = require("path");
const { loadDotEnv, checkCredentials } = require("./env");
const { PeakaClient } = require("./peakaClient");

/**
 * Measures what data actually exists in the target environment, ONCE per run,
 * so scenarios that need seeded data can be skipped rather than failing deep
 * inside themselves against someone else's account.
 *
 * WHY A FILE ON DISK. Jest decides which tests exist at module-load time,
 * which is synchronous - `await` is impossible there. So the measurement runs
 * in jest.globalSetup.js (async, once), writes here, and every test file reads
 * it back synchronously via load(). That is the whole reason this module is
 * split into an async half and a sync half.
 *
 * THE SAFETY RULE THAT MAKES SKIPPING ACCEPTABLE AT ALL. This repo previously
 * held that missing data must fail rather than skip, because a silent skip let
 * a run report green while verifying almost nothing (see the comment at
 * tests/stripe/c-data-and-cache.js:300 - a dashboard server died mid-run and
 * the next run quietly verified nothing). Skipping is only safe if it can never
 * be confused with either passing OR with a broken API, so:
 *
 *   - A query that SUCCEEDS and returns 0 rows  -> gate closed, scenario skips.
 *   - A query that FAILS (non-2xx, or throws)   -> measure() THROWS, and
 *     globalSetup aborts the entire run loudly.
 *
 * An outage can therefore never present as "no data, skip everything".
 *
 *   - A MISSING preflight file                  -> every gate reports OPEN.
 *     Absence of measurement must never cause a skip; it falls back to the old
 *     behaviour of running and failing honestly.
 */

const PREFLIGHT_PATH = path.join(__dirname, "..", "test-results", "preflight.json");

// Appended to a skipped test's NAME so the reason survives into Jest output,
// the JUnit XML, and the incompleteRun reporter without a cross-process channel.
const SKIP_MARKER = "[SKIPPED: ";

// F's pagination step reads two pages of 20, so it needs a second page to
// exist at all - see tests/stripe/f-error-handling.js.
const REFUNDS_MIN_ROWS = 21;

// Below this, a table cannot demonstrate anything about the ~100-row live cap.
const CAP_PROBE_MIN_ROWS = 100;

// Discovery cost guard: a schema with hundreds of tables would otherwise turn
// the preflight into a minutes-long scan.
const MAX_TABLES_TO_PROBE = 25;

/** A gate nothing can open, because the connector isn't configured at all. */
function unavailable(reason) {
  return { ok: false, reason };
}

function open() {
  return { ok: true, reason: null };
}

/**
 * Runs COUNT(*) and returns the number.
 *
 * Throws on a failed request rather than returning 0 - the distinction between
 * "no rows" and "could not ask" is the single most important thing this whole
 * module gets right.
 */
async function countRows(client, catalogName, schemaName, tableName, { attempts = 3 } = {}) {
  const sql = `SELECT COUNT(*) AS cnt FROM "${catalogName}"."${schemaName}"."${tableName}"`;
  let last = null;

  // RETRIED, because this gates the whole run. Peaka intermittently returns
  // transport-level errors ("HTTP/1.1 header parser received no bytes"), and a
  // single blip during the preflight would otherwise abort a run that would
  // have been perfectly fine. Only a PERSISTENT failure aborts - which keeps
  // the important property intact: a genuinely broken API still stops the run
  // rather than being mistaken for "no data, skip everything".
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await client.executeQuery({ statement: sql }, "SIMPLE");
      if (res.ok && res.body && Array.isArray(res.body.data)) return Number(res.body.data[0].cnt);
      last = `status ${res.status}: ${JSON.stringify(res.body)}`;
    } catch (err) {
      last = err.message;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }

  throw new Error(
    `Preflight could not query ${tableName} after ${attempts} attempts (${last}). ` +
      `This is an API/config failure, not missing data - refusing to treat it as "nothing to test".`
  );
}

async function measureStripe() {
  const check = checkCredentials("stripe");
  if (!check.ok) {
    const reason = "Stripe connector not configured (missing credentials in .env)";
    return {
      configured: false,
      gates: {
        // `configured` gates the scenarios that need the connector to EXIST
        // but assert nothing about its data - connections, catalogs, metadata
        // refresh, internal tables. Without it those scenarios threw on a
        // missing credential instead of skipping, so a clone with no Stripe
        // account saw seven hard failures next to six clean skips for one and
        // the same cause.
        configured: unavailable(reason),
        customers: unavailable(reason),
        charges: unavailable(reason),
        subscriptions: unavailable(reason),
        invoices: unavailable(reason),
        refunds: unavailable(reason),
      },
    };
  }

  const client = new PeakaClient({
    apiKey: check.values.PEAKA_API_KEY,
    projectId: check.values.PEAKA_PROJECT_ID,
  });
  const catalogId = check.values.PEAKA_CATALOG_ID;
  const schemaName = check.values.PEAKA_SCHEMA_NAME;

  // Same resolution order as helpers/resolveCatalogName.js.
  const catRes = await client.getCatalog(catalogId);
  const catalogName = catRes.ok && catRes.body && catRes.body.name ? catRes.body.name : process.env.PEAKA_CATALOG_NAME;
  if (!catalogName) {
    // A 4xx here means the id points at nothing - a CONFIG problem, which is
    // the ordinary state of a clone that never set up Stripe. That skips.
    // A 5xx means the API is broken, which must abort (see the module header).
    if (catRes.status >= 500) {
      throw new Error(
        `Preflight could not reach Peaka to resolve PEAKA_CATALOG_ID=${catalogId} ` +
          `(getCatalog returned ${catRes.status}). Aborting rather than reporting "no data".`
      );
    }
    const reason = `Stripe catalog '${catalogId}' not found (getCatalog returned ${catRes.status})`;
    return {
      configured: false,
      gates: {
        configured: unavailable(reason),
        customers: unavailable(reason),
        charges: unavailable(reason),
        subscriptions: unavailable(reason),
        invoices: unavailable(reason),
        refunds: unavailable(reason),
      },
    };
  }

  // THESE ARE CAPPED READS, NOT REAL COUNTS. A live COUNT(*) on a Stripe table
  // returns at most ~100 (the connector's documented cap - see FINDINGS.md), so
  // a 505-customer account measures as 100 here. That is fine for the ">0"
  // gating below, but never treat these as true row counts: scenario C derives
  // the real customer count from Stripe's own API instead.
  const counts = {};
  for (const table of ["customers", "charges", "subscriptions", "invoices", "refunds"]) {
    counts[table] = await countRows(client, catalogName, schemaName, table);
  }

  return {
    configured: true,
    catalogName,
    schemaName,
    counts,
    gates: {
      // Credentials are present and the catalog resolved - anything that only
      // needs the connector to exist can run.
      configured: open(),
      customers: counts.customers > 0 ? open() : unavailable("Stripe catalog has 0 customers"),
      charges: counts.charges > 0 ? open() : unavailable("Stripe catalog has 0 charges"),
      subscriptions: counts.subscriptions > 0 ? open() : unavailable("Stripe catalog has 0 subscriptions"),
      invoices: counts.invoices > 0 ? open() : unavailable("Stripe catalog has 0 invoices"),
      refunds:
        counts.refunds >= REFUNDS_MIN_ROWS
          ? open()
          : unavailable(`refunds has ${counts.refunds} rows, needs ${REFUNDS_MIN_ROWS} for two pages`),
    },
  };
}

async function measurePostgres() {
  const check = checkCredentials("postgres");
  if (!check.ok) {
    const reason = "Postgres connector not configured (missing PEAKA_PG_* in .env)";
    return {
      configured: false,
      gates: {
        largeTable: unavailable(reason),
        anyTable: unavailable(reason),
        credentials: unavailable(reason),
        connectionId: unavailable(reason),
      },
    };
  }

  const client = new PeakaClient({
    apiKey: check.values.PEAKA_API_KEY,
    projectId: check.values.PEAKA_PROJECT_ID,
  });
  const catalogId = check.values.PEAKA_PG_CATALOG_ID;
  const schemaName = check.values.PEAKA_PG_SCHEMA_NAME;

  const catRes = await client.getCatalog(catalogId);
  if (!catRes.ok || !catRes.body || !catRes.body.name) {
    // As with Stripe above: a 4xx means the configured id points at nothing,
    // which is a setup gap and skips. Only a 5xx is an outage worth aborting on.
    if (catRes.status >= 500) {
      throw new Error(
        `Preflight could not reach Peaka to resolve PEAKA_PG_CATALOG_ID=${catalogId} ` +
          `(getCatalog returned ${catRes.status}). Aborting rather than reporting "no data".`
      );
    }
    const reason = `Postgres catalog '${catalogId}' not found (getCatalog returned ${catRes.status})`;
    return {
      configured: false,
      gates: {
        largeTable: unavailable(reason),
        anyTable: unavailable(reason),
        credentials: unavailable(reason),
        connectionId: unavailable(reason),
      },
    };
  }
  const catalogName = catRes.body.name;

  const tablesRes = await client.listTables(catalogId, schemaName);
  if (!tablesRes.ok) {
    throw new Error(
      `Preflight could not list tables in ${schemaName} (status ${tablesRes.status}): ` +
        `${JSON.stringify(tablesRes.body)}`
    );
  }
  const tableNames = (tablesRes.body || []).map((t) => t.tableName || t.name).filter(Boolean);

  if (tableNames.length === 0) {
    const reason = `Postgres schema '${schemaName}' has no tables`;
    return {
      configured: true,
      catalogName,
      schemaName,
      gates: {
        largeTable: unavailable(reason),
        anyTable: unavailable(reason),
        credentials: unavailable(reason),
        connectionId: unavailable(reason),
      },
    };
  }

  // An explicit hint wins, so a user with a known fixture avoids the scan.
  const hinted = process.env.PEAKA_PG_TABLE;
  const candidates = hinted && tableNames.includes(hinted) ? [hinted] : tableNames.slice(0, MAX_TABLES_TO_PROBE);

  let largest = null;
  let largestCount = -1;
  for (const table of candidates) {
    const count = await countRows(client, catalogName, schemaName, table);
    if (count > largestCount) {
      largestCount = count;
      largest = table;
    }
    // Big enough to prove the cap point; no need to keep scanning.
    if (hinted || largestCount > CAP_PROBE_MIN_ROWS * 5) break;
  }

  // Connection-lifecycle testing needs the DATABASE credentials, not just the
  // catalog id - everything else in this folder reuses the existing connection.
  // Checked for presence only; whether they actually authenticate is PG-E's
  // first assertion, not a preflight concern.
  const CONNECTION_VARS = [
    "PEAKA_PG_URL",
    "PEAKA_PG_PORT",
    "PEAKA_PG_USER",
    "PEAKA_PG_PASSWORD",
    "PEAKA_PG_DATABASE",
    "PEAKA_PG_USE_SSL",
  ];
  const missingConnVars = CONNECTION_VARS.filter((v) => !process.env[v]);

  return {
    configured: true,
    catalogName,
    schemaName,
    largestTable: largest,
    largestTableRowCount: largestCount,
    gates: {
      anyTable: open(),
      // PEAKA_PG_CONNECTION_ID is optional config, not a required env var
      // (see tests/postgres/config.js) - but PG-G and PG-I create a catalog on
      // an existing connection and cannot run without it. They used to assert
      // on it mid-scenario and hard-fail; gating means they skip like anything
      // else whose configuration is absent.
      connectionId: process.env.PEAKA_PG_CONNECTION_ID
        ? open()
        : unavailable(
            "PEAKA_PG_CONNECTION_ID is not set - these scenarios create a catalog on an existing " +
              "connection, so they need its id (not its credentials)"
          ),
      credentials:
        missingConnVars.length === 0
          ? open()
          : unavailable(
              `connection-lifecycle testing needs ${missingConnVars.join(", ")} in .env ` +
                `(everything else in this folder reuses the existing connection instead)`
            ),
      largeTable:
        largestCount > CAP_PROBE_MIN_ROWS
          ? open()
          : unavailable(
              `no table in '${schemaName}' exceeds ${CAP_PROBE_MIN_ROWS} rows ` +
                `(largest is '${largest}' with ${largestCount}), so the row-cap claim is untestable`
            ),
    },
  };
}

/**
 * A THIRD connector, mostly to see whether Postgres's two settled attribution
 * questions (cap is connector-specific, string serialization is platform-wide)
 * hold for a document store too, or were secretly relational-database-specific.
 * They hold - see tests/mongodb/config.js. What's actually new is `_id`, which
 * this does not measure (mo-a-discovery.js probes it directly against the
 * configured schema; there is nothing to gate on, since the field's absence
 * from listColumns is itself the finding, not a precondition for one).
 *
 * Structurally simpler than measurePostgres(): no separate connection-lifecycle
 * env-var block, because this folder has no connection-CRUD scenario yet (the
 * Postgres one, PG-E, took its own session to build).
 */
async function measureMongoDB() {
  const check = checkCredentials("mongodb");
  if (!check.ok) {
    const reason = "MongoDB connector not configured (missing PEAKA_MONGO_* in .env)";
    return {
      configured: false,
      gates: { anyTable: unavailable(reason), largeTable: unavailable(reason), connectionId: unavailable(reason) },
    };
  }

  const client = new PeakaClient({
    apiKey: check.values.PEAKA_API_KEY,
    projectId: check.values.PEAKA_PROJECT_ID,
  });
  const catalogId = check.values.PEAKA_MONGO_CATALOG_ID;
  const schemaName = check.values.PEAKA_MONGO_SCHEMA_NAME;

  // MO-G and MO-I create a throwaway catalog on the existing connection rather
  // than a live one - same reasoning as Postgres's connectionId gate.
  const connectionIdGate = process.env.PEAKA_MONGO_CONNECTION_ID
    ? open()
    : unavailable(
        "PEAKA_MONGO_CONNECTION_ID is not set - these scenarios create a catalog on an existing connection, " +
          "so they need its id (not its credentials)"
      );

  const catRes = await client.getCatalog(catalogId);
  if (!catRes.ok || !catRes.body || !catRes.body.name) {
    if (catRes.status >= 500) {
      throw new Error(
        `Preflight could not reach Peaka to resolve PEAKA_MONGO_CATALOG_ID=${catalogId} ` +
          `(getCatalog returned ${catRes.status}). Aborting rather than reporting "no data".`
      );
    }
    const reason = `MongoDB catalog '${catalogId}' not found (getCatalog returned ${catRes.status})`;
    return {
      configured: false,
      gates: { anyTable: unavailable(reason), largeTable: unavailable(reason), connectionId: connectionIdGate },
    };
  }
  const catalogName = catRes.body.name;

  const tablesRes = await client.listTables(catalogId, schemaName);
  if (!tablesRes.ok) {
    throw new Error(
      `Preflight could not list tables in ${schemaName} (status ${tablesRes.status}): ` +
        `${JSON.stringify(tablesRes.body)}`
    );
  }
  const tableNames = (tablesRes.body || []).map((t) => t.tableName || t.name).filter(Boolean);

  if (tableNames.length === 0) {
    const reason = `MongoDB schema '${schemaName}' has no tables`;
    return {
      configured: true,
      catalogName,
      schemaName,
      gates: { anyTable: unavailable(reason), largeTable: unavailable(reason), connectionId: connectionIdGate },
    };
  }

  let largest = null;
  let largestCount = -1;
  for (const table of tableNames.slice(0, MAX_TABLES_TO_PROBE)) {
    const count = await countRows(client, catalogName, schemaName, table);
    if (count > largestCount) {
      largestCount = count;
      largest = table;
    }
    if (largestCount > CAP_PROBE_MIN_ROWS * 5) break;
  }

  return {
    configured: true,
    catalogName,
    schemaName,
    largestTable: largest,
    largestTableRowCount: largestCount,
    gates: {
      anyTable: open(),
      largeTable:
        largestCount > CAP_PROBE_MIN_ROWS
          ? open()
          : unavailable(
              `no collection in '${schemaName}' exceeds ${CAP_PROBE_MIN_ROWS} rows ` +
                `(largest is '${largest}' with ${largestCount}), so the row-cap claim is untestable`
            ),
      connectionId: connectionIdGate,
    },
  };
}

/**
 * Called by jest.globalSetup.js. Throws if the environment cannot be measured -
 * that failure must abort the run rather than silently disabling scenarios.
 */
/**
 * The peaka-tables folder needs no connector credentials, so for a long time it
 * had no branch here at all - which is exactly why every wrapper in it carries
 * a note saying gatedTest must NOT be used, since gate() defaults OPEN for an
 * unknown key and a gated call would silently always run while LOOKING gated.
 *
 * One thing there does need measuring: whether a BI Table with rows exists.
 * BI Table has no write path through the Partner API (its rows can only be
 * entered through Studio), so a scenario that reads them cannot seed its own
 * fixture and must skip when the environment has none - the same position the
 * Postgres folder is in, handled the same way.
 */
async function measurePeakaTables() {
  const check = checkCredentials("peaka-tables");
  if (!check.ok) {
    const reason = "Core Peaka credentials missing";
    return { configured: false, gates: { biTableWithData: unavailable(reason) } };
  }

  const client = new PeakaClient({
    apiKey: check.values.PEAKA_API_KEY,
    projectId: check.values.PEAKA_PROJECT_ID,
  });

  const list = await client.listBiTables();
  if (!list.ok) {
    if (list.status >= 500) {
      throw new Error(`Preflight could not list BI Tables (${list.status}). Aborting rather than reporting "no data".`);
    }
    return {
      configured: true,
      gates: { biTableWithData: unavailable(`listBiTables returned ${list.status}`) },
    };
  }

  // Find the first BI Table that actually holds rows, and remember which
  // user-declared columns it has - a reader needs at least one to assert on.
  for (const table of list.body || []) {
    const name = table.tableName;
    const res = await client.executeQuery(
      { statement: `SELECT COUNT(*) AS cnt FROM "peaka"."bitable"."${name}"` },
      "SIMPLE"
    );
    if (!res.ok || !res.body || !Array.isArray(res.body.data)) continue;
    const rowCount = Number(res.body.data[0].cnt);
    if (rowCount <= 0) continue;

    const cols = await client.listBiTableColumns(name);
    const userColumns = (cols.body || [])
      .map((c) => c.name)
      .filter((n) => n && !String(n).startsWith("_"));
    if (userColumns.length === 0) continue;

    return {
      configured: true,
      biTable: name,
      biTableRowCount: rowCount,
      biTableColumns: userColumns,
      gates: { biTableWithData: open() },
    };
  }

  return {
    configured: true,
    gates: {
      biTableWithData: unavailable(
        "no BI Table in this project holds rows - they can only be entered through Studio, " +
          "so there is nothing for a reader to assert against"
      ),
    },
  };
}

async function measure() {
  loadDotEnv();
  const report = {
    measuredAt: new Date().toISOString(),
    stripe: await measureStripe(),
    postgres: await measurePostgres(),
    mongodb: await measureMongoDB(),
    peakaTables: await measurePeakaTables(),
  };

  // A COMPOSITE GATE, because one scenario needs TWO connectors. The federated
  // join asks whether the Stripe cap survives a join, and proves the join
  // mechanism is not itself the limiter by running the same join against
  // Postgres as a control. Gating it on stripe alone left it hard-failing
  // whenever Postgres was absent or pointed elsewhere - the same "gated on
  // less than it needs" bug that PG-G and PG-I had.
  const stripeReady = report.stripe.gates && report.stripe.gates.customers && report.stripe.gates.customers.ok;
  const postgresReady = report.postgres.gates && report.postgres.gates.anyTable && report.postgres.gates.anyTable.ok;
  report.peakaTables.gates.federatedJoin = stripeReady && postgresReady
    ? open()
    : unavailable(
        `needs BOTH connectors - stripe.customers ${stripeReady ? "open" : "closed"}, ` +
          `postgres.anyTable ${postgresReady ? "open" : "closed"}`
      );
  fs.mkdirSync(path.dirname(PREFLIGHT_PATH), { recursive: true });
  fs.writeFileSync(PREFLIGHT_PATH, JSON.stringify(report, null, 2));
  return report;
}

let cached;
/** Synchronous read for test files. Returns null if no measurement exists. */
function load() {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(PREFLIGHT_PATH, "utf8"));
  } catch (_) {
    cached = null;
  }
  return cached;
}

/**
 * Looks up one gate, e.g. gate("stripe.customers").
 *
 * Defaults to OPEN whenever the answer isn't known - a missing preflight file,
 * an unknown connector, or an unknown capability all run the scenario rather
 * than skipping it. Skipping is only ever the result of a real measurement
 * saying the data is absent.
 */
function gate(key) {
  const report = load();
  if (!report) return open();
  const [connector, capability] = key.split(".");
  const c = report[connector];
  if (!c || !c.gates || !c.gates[capability]) return open();
  return c.gates[capability];
}

/**
 * Declares a test that runs only if its gate is open.
 *
 * A closed gate produces a real `test.skip`, which Jest counts and colours
 * separately from a pass - unlike the `console.log` + `return` inside a step()
 * that this replaces, which the reporter counted as a PASSING step.
 *
 * The reason is appended to the test NAME rather than merely logged, so it
 * survives into Jest's output, the JUnit XML, and jest/reporters/incompleteRun.js
 * (which parses it back out) without needing any cross-process channel.
 */
function gatedTest(name, gateKey, fn, timeout) {
  const g = gate(gateKey);
  if (g.ok) return test(name, fn, timeout);
  return test.skip(`${name} ${SKIP_MARKER}${g.reason}]`, fn, timeout);
}

/**
 * The pieces of gatedTest, for callers that need a different runner -
 * jest/stripe/connector.test.js uses test.concurrent, which gatedTest's plain
 * `test` would silently serialise.
 *
 *   const g = gateFor("C: ...", "stripe.customers");
 *   (g.ok ? test.concurrent : test.concurrent.skip)(g.name, fn, timeout);
 */
function gateFor(name, gateKey) {
  const g = gate(gateKey);
  return g.ok ? { ok: true, name, reason: null } : { ok: false, name: `${name} ${SKIP_MARKER}${g.reason}]`, reason: g.reason };
}

module.exports = { measure, load, gate, gatedTest, gateFor, PREFLIGHT_PATH, SKIP_MARKER };
