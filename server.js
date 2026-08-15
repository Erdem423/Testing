/**
 * Peaka Test - Web Dashboard
 * ------------------------------------------------------
 * Doesn't call the underlying tests/<connector>/*.js functions directly - it
 * invokes Jest's own programmatic API (runCLI, the same function the `jest`
 * CLI command itself calls under the hood) with a custom reporter
 * (jest/browserReporter.js) that streams live per-test results to the
 * browser over Server-Sent Events, instead of just printing to a terminal.
 *
 * This means: clicking "Run tests" in the browser runs the EXACT same real
 * Jest suite as `npm test` - same test.concurrent() scheduling, same
 * afterAll cleanup, same everything. The dashboard is purely a different
 * way to trigger and watch a real Jest run, not an alternate execution path.
 *
 * CONNECTOR FOLDERS ARE DISCOVERED DYNAMICALLY, NOT HARDCODED.
 * Each subfolder of tests/ that contains a meta.js becomes a folder card in
 * the web app's landing screen automatically - see discoverConnectors()
 * below and tests/stripe/meta.js for the pattern. Adding a new connector
 * (Mongo, Supabase, etc.) later means creating tests/<name>/ + a meta.js +
 * jest/<name>/connector.test.js - no server.js edits needed.
 *
 * Credentials (.env) are only ever read by the Jest process itself - the
 * browser never sees them, only pass/fail results and error messages.
 *
 * SETUP:
 *   npm install
 *   Edit .env with your real credentials (see .env for details)
 *
 * RUN:
 *   npm run web
 *   Then open http://localhost:3000
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");
const { loadDotEnv, checkCredentials, loadConnectorConfig, PLACEHOLDER_VALUES } = require("./helpers/env");
const { PeakaClient } = require("./helpers/peakaClient");
const { discoverAllProjects, resolveDynamicConnectorConfig } = require("./helpers/peakaAccount");
const reporterBus = require("./jest/reporterBus");
const { SIDECAR_DIR: SERVER_ERROR_DIR } = require("./helpers/serverError");

loadDotEnv();

// Defensive: log any unhandled rejection/exception with a full stack trace
// rather than letting the process die silently (Node 15+ terminates on
// unhandled rejections by default). Verified this server itself runs
// cleanly through a full Jest run without triggering either of these -
// keeping them as a safety net for whatever gets added here later.
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

const app = express();
app.use(express.json());

// ---------- Security headers ----------
// This server now holds a live Partner API key (typed into the Connect
// screen, see the session below) for the life of the process - worth
// actually hardening, not just trusting "it's localhost" blindly. No new
// dependency (no helmet) - same "no external HTTP dependency needed"
// philosophy as helpers/peakaClient.js, just plain header-setting.
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
      "script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  res.setHeader("X-Frame-Options", "DENY"); // this dashboard can trigger real test runs - never let another site iframe it (clickjacking)
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Blocks the "malicious page open in another tab" drive-by class: without
// this, ANY website you happen to have open could silently POST to
// http://localhost:3000/api/... (browsers don't block cross-origin requests
// from being SENT, only from letting the attacker page read the response) -
// e.g. calling /api/run-stream to kick off a real test run, or /api/peaka/
// connect to hijack your session, using whatever this dashboard is
// currently doing. A same-origin request from the dashboard's own page
// always carries a matching Origin (state-changing POSTs) or Referer (GETs/
// EventSource) header; anything else gets rejected. Requests with NEITHER
// header (server-to-server, e.g. helpers/stepReporter.js posting back to
// itself, or a direct curl/CLI call) are left alone - there's no browser
// origin to spoof in that case.
function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (_) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (originHost !== req.headers.host) {
    return res.status(403).json({ error: "Cross-origin requests are not allowed." });
  }
  next();
}
app.use("/api", requireSameOrigin);

app.use(express.static(path.join(__dirname, "public")));

let runInProgress = false;
// The forked Jest process for whatever run is currently in progress (see
// /api/run-stream), and whether /api/cancel-run has been asked to kill it -
// tracked here so the cancel endpoint (a separate HTTP request from the SSE
// stream's own) can reach it, and so the run-stream handler knows whether an
// exit was requested or the run just finished normally.
let currentChild = null;
let cancelRequested = false;

const TESTS_DIR = path.join(__dirname, "tests");
const PORT = process.env.PORT || 3000;

/**
 * Live per-step events arrive here over HTTP from helpers/stepReporter.js,
 * and get re-emitted onto the same bus the Jest reporter uses so they reach
 * the browser through the existing SSE stream.
 *
 * WHY HTTP RATHER THAN THE SHARED BUS DIRECTLY: test files can't reach
 * reporterBus. Everything a test requires goes through jest-runtime's
 * sandboxed module registry, so a `require` of reporterBus from inside a test
 * yields a different EventEmitter than this process holds. Reporters are
 * exempt (Jest loads those itself), which is why browserReporter.js can use
 * the bus but test code cannot. See helpers/stepReporter.js for the full note.
 */
app.post("/api/step-event", (req, res) => {
  const event = req.body;
  if (event && typeof event.type === "string") {
    reporterBus.emit("event", event);
  }
  res.status(204).end();
});

/**
 * Scans tests/ for subfolders containing a meta.js, and returns each as a
 * connector folder descriptor. This is the ONLY place that needs to know
 * about connector folders - everything else (routes, frontend) works off
 * whatever this returns, so adding tests/mongo/meta.js later is enough for
 * it to show up with zero other code changes.
 */
function discoverConnectors() {
  if (!fs.existsSync(TESTS_DIR)) return [];
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());

  const connectors = [];
  for (const entry of entries) {
    const metaPath = path.join(TESTS_DIR, entry.name, "meta.js");
    if (!fs.existsSync(metaPath)) continue; // folder without meta.js isn't a connector folder, skip
    try {
      delete require.cache[require.resolve(metaPath)]; // pick up edits without restarting the server
      const meta = require(metaPath);
      connectors.push({ id: entry.name, displayName: meta.displayName || entry.name, icon: meta.icon || "📁", scenarios: meta.scenarios || [] });
    } catch (err) {
      console.error(`Failed to load meta.js for tests/${entry.name}:`, err.message);
    }
  }
  return connectors;
}

app.get("/api/folders", (req, res) => {
  const connectors = discoverConnectors();
  res.json({
    folders: connectors.map((c) => ({ id: c.id, displayName: c.displayName, icon: c.icon, scenarioCount: c.scenarios.length })),
  });
});

app.get("/api/scenarios", (req, res) => {
  const folderId = req.query.folder;
  const connector = discoverConnectors().find((c) => c.id === folderId);
  if (!connector) {
    return res.status(404).json({ error: `Unknown folder: ${folderId}` });
  }
  res.json({ scenarios: connector.scenarios });
});

/**
 * The dashboard's home page is a real "connect with your Partner API key"
 * screen - typing a key in works standalone, with no .env editing required.
 * Deliberately NOT seeded from .env at boot: every server start shows the
 * Connect screen and requires an explicit key (masked input, see
 * public/index.html's #api-key-input), so this stays genuinely dynamic per
 * person/account rather than silently reusing whoever's PEAKA_API_KEY/
 * PEAKA_PROJECT_ID happens to be sitting in .env. .env is still read (see
 * loadDotEnv() above) but only for the CLI path (`npm test`) and for the
 * third-party connector tokens (STRIPE_TEST_TOKEN/HUBSPOT_ACCESS_TOKEN) that
 * G/H/L/M/N need regardless of which project is picked here.
 *
 * This in-memory session is intentionally simple (a single global, not
 * per-browser-tab/cookie): the dashboard is a local single-user tool (see
 * README - `npm run web` on localhost only, one person at a time). It is
 * NOT safe for multiple people to use the same running server concurrently -
 * they'd share (and clobber) this one session.
 */
const session = {
  apiKey: null,
  projectId: null,
};

/**
 * Tries to discover every project a key can see. Classifies the result so
 * the frontend can react correctly to each real case (confirmed against the
 * live API, not guessed):
 *   - "multi"   the key can list organizations/workspaces/projects - the
 *               normal home page (project grid) applies.
 *   - "scoped"  the key is valid but scoped to a single project (a real
 *               403 Forbidden on org-listing, even though the SAME key
 *               works fine for that project's own connections/catalogs) -
 *               the frontend then asks for that one Project ID.
 *   - "invalid" anything else (401, network error, ...) - the key itself
 *               doesn't work.
 */
async function classifyApiKey(apiKey) {
  try {
    const projects = await discoverAllProjects(apiKey);
    return { kind: "multi", projects };
  } catch (err) {
    if (err.status === 403) return { kind: "scoped" };
    return { kind: "invalid", error: err.status === 401 ? "Invalid Partner API key." : err.message };
  }
}

/** Resolves the session's current state into what the frontend needs to render. */
async function describeSession() {
  if (!session.apiKey) return { ok: true, connected: false };

  const result = await classifyApiKey(session.apiKey);
  if (result.kind === "invalid") {
    session.apiKey = null;
    session.projectId = null;
    return { ok: true, connected: false, error: result.error };
  }
  if (result.kind === "multi") {
    return { ok: true, connected: true, mode: "multi", projects: result.projects };
  }
  // scoped: we already know which project from a previous connect-project
  // call (or from .env's PEAKA_PROJECT_ID at boot) - skip straight past the
  // project-id prompt in that case.
  if (session.projectId) {
    return { ok: true, connected: true, mode: "single", project: { id: session.projectId, name: session.projectId } };
  }
  return { ok: true, connected: true, mode: "scoped-needs-project" };
}

app.get("/api/peaka/session", async (req, res) => {
  res.json(await describeSession());
});

app.post("/api/peaka/connect", async (req, res) => {
  const apiKey = (req.body && req.body.apiKey || "").trim();
  if (!apiKey) {
    return res.json({ ok: false, error: "Enter a Partner API key." });
  }

  const result = await classifyApiKey(apiKey);
  if (result.kind === "invalid") {
    return res.json({ ok: false, error: result.error });
  }

  session.apiKey = apiKey;
  session.projectId = null; // switching keys - forget any previously resolved single project
  process.env.PEAKA_API_KEY = apiKey; // buildCtx.js/checkCredentials() read this fresh on every run

  if (result.kind === "multi") {
    return res.json({ ok: true, mode: "multi", projects: result.projects });
  }
  res.json({ ok: true, mode: "scoped-needs-project" });
});

app.post("/api/peaka/connect-project", async (req, res) => {
  if (!session.apiKey) {
    return res.json({ ok: false, error: "Not connected - enter a Partner API key first." });
  }
  const projectId = (req.body && req.body.projectId || "").trim();
  if (!projectId) {
    return res.json({ ok: false, error: "Enter a Project ID." });
  }

  try {
    const client = new PeakaClient({ apiKey: session.apiKey, projectId });
    const connRes = await client.listConnections();
    if (!connRes.ok) {
      return res.json({
        ok: false,
        error: connRes.status === 404 ? "No project with this ID was found for this key." : `Could not verify this project (status ${connRes.status}).`,
      });
    }
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }

  session.projectId = projectId;
  process.env.PEAKA_PROJECT_ID = projectId;
  res.json({ ok: true, project: { id: projectId, name: projectId } });
});

app.post("/api/peaka/disconnect", (req, res) => {
  session.apiKey = null;
  session.projectId = null;
  delete process.env.PEAKA_API_KEY;
  delete process.env.PEAKA_PROJECT_ID;
  res.json({ ok: true });
});

/**
 * Connectors actually attached to one project - listed from its CATALOGS,
 * not from listConnections(). Confirmed against the real API that these
 * disagree: listConnections() can come back an empty [] for a project that
 * demonstrably has working Stripe/HubSpot/Mongo/etc. catalogs (each with a
 * real connectionId, verified via getCatalog/listCatalogs). Catalogs are the
 * reliable source - every non-internal one already carries connectionId AND
 * catalogType (which doubles as the connector's type, e.g. "stripe"), so no
 * separate listConnections() call is even needed.
 *
 * Each result is cross-referenced against discoverConnectors() so the
 * frontend knows which ones this repo can actually run tests for (hasTests)
 * - a project may well have catalogs (Mongo, Postgres, Pinecone, ...) this
 * suite doesn't cover yet.
 */
app.get("/api/peaka/projects/:projectId/connectors", async (req, res) => {
  if (!session.apiKey) {
    return res.json({ ok: false, error: "Not connected - enter a Partner API key first." });
  }
  const apiKey = session.apiKey;
  const { projectId } = req.params;
  try {
    const client = new PeakaClient({ apiKey, projectId });
    const catalogsRes = await client.listCatalogs();
    if (!catalogsRes.ok) {
      return res.json({ ok: false, error: `Could not list catalogs for this project (status ${catalogsRes.status}).` });
    }
    const testFolders = discoverConnectors(); // { id, displayName, icon, scenarios }[]
    const catalogs = (Array.isArray(catalogsRes.body) ? catalogsRes.body : []).filter((c) => c.connectionId); // drop internal/built-in catalogs (connectionId null/"")
    const connectors = catalogs.map((c) => {
      const folder = testFolders.find((f) => f.id === c.catalogType);
      return {
        connectionId: c.connectionId,
        name: c.displayName || c.name,
        type: c.catalogType,
        hasTests: Boolean(folder),
        folderId: folder ? folder.id : null,
        displayName: folder ? folder.displayName : c.catalogType,
        icon: folder ? folder.icon : "🔌",
        scenarioCount: folder ? folder.scenarios.length : 0,
      };
    });
    res.json({ ok: true, connectors });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Folder id -> the connector id checkCredentials() should validate against.
// "races" and "hubspot-races" test the same connector as "stripe"/"hubspot"
// respectively (see tests/races/*.js and tests/hubspot-races/*.js - both
// build a throwaway connection using that connector's credentials), they
// just live in a separate folder for isolation, not a separate connector.
const CREDENTIAL_CONNECTOR_FOR_FOLDER = {
  stripe: "stripe",
  races: "stripe",
  hubspot: "hubspot",
  "hubspot-races": "hubspot",
};

/**
 * Resolves a picked project + connection to catalog/schema config and
 * overwrites the connector's env vars (per its tests/<id>/config.js -
 * catalogIdEnv/schemaEnv/catalogNameEnv, see helpers/env.js's
 * loadConnectorConfig) for the CURRENT process, the same way
 * process.env.PEAKA_STEP_REPORT_URL is set below before each run -
 * buildCtx.js and checkCredentials() read process.env fresh every time
 * they're called, so this is enough to make the next check/run see the
 * picked project/connection instead of whatever's static in .env. Does
 * nothing (returns null) when projectId/connectionId aren't both supplied,
 * so the old .env-only CLI path (and any request that omits them) is
 * unaffected.
 */
async function applyDynamicConnectorConfig(connectorId, projectId, connectionId) {
  if (!projectId || !connectionId) return null;
  const config = loadConnectorConfig(connectorId);
  if (!config) return null;

  const apiKey = process.env.PEAKA_API_KEY;
  if (!apiKey || PLACEHOLDER_VALUES.has(apiKey)) {
    throw new Error("PEAKA_API_KEY is not set in .env (or is still a placeholder value).");
  }

  const resolved = await resolveDynamicConnectorConfig({ apiKey, projectId, connectionId, connectorId });
  process.env.PEAKA_PROJECT_ID = projectId;
  process.env[config.catalogIdEnv] = resolved.catalogId;
  if (config.catalogNameEnv) process.env[config.catalogNameEnv] = resolved.catalogName;
  process.env[config.schemaEnv] = resolved.schemaName;
  return resolved;
}

app.get("/api/config-status", async (req, res) => {
  // Deliberately reuse the exact same credential check Jest itself will run -
  // see helpers/env.js. This is just an early, friendlier warning before the
  // user clicks "Run tests" and Jest fails on every test with the same message.
  //
  // MUST be folder-aware: checkCredentials() is per-connector, so checking
  // "stripe" unconditionally (the old behavior) either wrongly disables the
  // Run buttons for a correctly-configured HubSpot folder when only Stripe's
  // creds are set, or wrongly reports "OK" for an unconfigured HubSpot folder
  // when only Stripe's are. req.query.folder is optional (older cached
  // frontend code, or a direct API call) and falls back to "stripe" to match
  // the previous default.
  const connectorId = CREDENTIAL_CONNECTOR_FOR_FOLDER[req.query.folder] || "stripe";

  try {
    // projectId/connectionId come from the dashboard's project/connector
    // picker - see public/app.js's showRunner(). Resolves and overwrites the
    // catalog/schema env vars for this connector before checking them below.
    await applyDynamicConnectorConfig(connectorId, req.query.projectId, req.query.connectionId);
  } catch (err) {
    return res.json({ ok: false, errors: [err.message] });
  }

  // A coarse "is there enough configured to attempt SOMETHING in this
  // folder" gate for the Run buttons, not a per-scenario guarantee.
  // checkCredentials() only requires what that connector's tests/<id>/
  // config.js declares in requiredEnv - for HubSpot that deliberately
  // excludes HUBSPOT_ACCESS_TOKEN (see tests/hubspot/config.js), so this
  // naturally behaves like the old requireToken:false check without needing
  // a special case here. Individual scenarios that DO need the token
  // (G/H/L/M/N, races) still gate themselves correctly - see
  // tests/hubspot/checkTokenCredentials.js.
  const check = checkCredentials(connectorId);
  if (check.ok) {
    res.json({ ok: true });
  } else {
    res.json({ ok: false, errors: check.errors });
  }
});

app.get("/api/run-stream", async (req, res) => {
  if (runInProgress) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "A test run is already in progress" }));
    return;
  }

  const folderId = req.query.folder;
  const connector = discoverConnectors().find((c) => c.id === folderId);
  if (!connector) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Unknown folder: ${folderId}` }));
    return;
  }

  try {
    // Same resolution as /api/config-status - overwrites this connector's
    // catalog/schema env vars for the run about to happen, from the
    // project/connection picked in the dashboard.
    const credConnectorId = CREDENTIAL_CONNECTOR_FOR_FOLDER[folderId] || folderId;
    await applyDynamicConnectorConfig(credConnectorId, req.query.projectId, req.query.connectionId);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  // Optional ?names=G: Connection Endpoints,C: Data Correctness (comma-separated,
  // URL-encoded) - restricts Jest to just these tests via testNamePattern,
  // for the dashboard's "Run Selected" button. Omitted/empty = run everything
  // in this folder ("Run All").
  const namesParam = req.query.names;
  let testNamePattern;
  if (typeof namesParam === "string" && namesParam.trim().length > 0) {
    const selectedNames = namesParam.split(",").map((n) => n.trim()).filter(Boolean);
    const escaped = selectedNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    testNamePattern = `^(${escaped.join("|")})$`;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Listen on the shared bus for the duration of this run only - events
  // arrive here via /api/step-event (POSTed by the forked Jest process's
  // reporter/step helpers - see jest/browserReporter.js and helpers/
  // stepReporter.js), which re-emits onto this bus.
  //
  // sawDone tracks whether browserReporter.js's onRunComplete already fired
  // (a NORMAL end of run - whether the tests passed or failed doesn't matter,
  // Jest still exits non-zero on a failing run). Only an exit we DIDN'T see a
  // "done" for means something crashed before completing normally.
  let sawDone = false;
  const onBusEvent = (event) => {
    if (event.type === "done") sawDone = true;
    send(event);
  };
  reporterBus.on("event", onBusEvent);

  runInProgress = true;
  cancelRequested = false;
  const stepReportUrl = `http://127.0.0.1:${PORT}/api/step-event`;

  // Clear per-run server-error records. jest.globalSetup.js does this too,
  // but the inline config below deliberately does NOT include globalSetup
  // (same reason upstream's did not: it's a purpose-built dashboard config,
  // not jest.config.js) - so without this line a dashboard run would leave
  // records behind that the next `npm test` would report as phantom warnings.
  try {
    fs.rmSync(SERVER_ERROR_DIR, { recursive: true, force: true });
  } catch (_) {
    // Reporting hygiene only - never worth failing a run over.
  }

  // Forked as its own OS process (not called in-process via runCLI, like the
  // original design) specifically so it can be killed - see /api/cancel-run
  // and jest/runInChild.js for why. child.send()/IPC is unused on purpose:
  // live events reach this process over the SAME HTTP mechanism regardless
  // of whether Jest runs in-process or forked (stepReportUrl above), so
  // runInChild.js stays a dumb runner with no message-passing logic.
  currentChild = fork(path.join(__dirname, "jest", "runInChild.js"), [], {
    cwd: __dirname,
    env: {
      ...process.env,
      PEAKA_STEP_REPORT_URL: stepReportUrl,
      JEST_RUN_CONFIG: JSON.stringify({
        // Same project config (jest.config.js) plus our streaming reporter
        // added alongside the normal ones - junit.xml still gets written.
        // testMatch is scoped to THIS folder's jest/<id>/ directory, so
        // running the Stripe folder never touches another connector's tests.
        config: JSON.stringify({
          testEnvironment: "node",
          testMatch: [`**/jest/${connector.id}/**/*.test.js`],
          testTimeout: 30000,
          reporters: [
            "default",
            ["jest-junit", { outputDirectory: "./test-results", outputName: `junit-${connector.id}.xml` }],
            path.join(__dirname, "jest", "browserReporter.js"),
          ],
        }),
        testNamePattern,
      }),
    },
  });

  currentChild.on("error", (err) => {
    send({ type: "fatal", message: err.message });
  });

  currentChild.on("exit", (code) => {
    if (cancelRequested) {
      // Jest's afterAll() cleanup never ran for whatever was mid-flight -
      // real Peaka resources it had already created may still exist. Said
      // plainly in the event so the browser can warn, not hide it.
      send({
        type: "cancelled",
        message: "Run stopped. Any Peaka resources the stopped scenario had already created were NOT cleaned up (afterAll never ran) - check Peaka Studio if in doubt.",
      });
    } else if (code !== 0 && !sawDone) {
      // Non-zero exit is EXPECTED and normal for a run with failing tests
      // (Jest itself exits 1 then) - browserReporter.js's "done" event
      // already covers that case on its own. This branch only catches a
      // real crash: the process died before ever completing a run.
      send({ type: "fatal", message: `Test process exited unexpectedly with code ${code}` });
    }
    reporterBus.off("event", onBusEvent);
    currentChild = null;
    cancelRequested = false;
    runInProgress = false;
    res.end();
  });

  // If the browser navigates away / closes the EventSource mid-run, there's
  // no one left to show results to - stop burning real API calls/resources
  // for a run nobody's watching, same spirit as the explicit Stop button.
  req.on("close", () => {
    if (currentChild) currentChild.kill();
  });
});

app.post("/api/cancel-run", (req, res) => {
  if (!currentChild) {
    return res.json({ ok: false, error: "No run in progress." });
  }
  cancelRequested = true;
  currentChild.kill(); // on Windows this always force-terminates; on POSIX SIGTERM is Node's default kill() signal
  res.json({ ok: true });
});

// Bound explicitly to 127.0.0.1 - without a host, Node listens on ALL
// interfaces (0.0.0.0) by default, meaning anyone else on the same
// Wi-Fi/LAN could reach this dashboard (and whatever Partner API key session
// is currently connected) at your machine's network IP. This is a real dev-
// tool-with-no-auth risk, not a hypothetical one, now that the dashboard
// holds a live key rather than just reading .env server-side.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Peaka Test dashboard running at http://localhost:${PORT} (127.0.0.1 only)`);
  console.log("Press Ctrl+C to stop.");
});
