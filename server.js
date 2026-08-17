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
const crypto = require("crypto");
const { fork } = require("child_process");
const { loadDotEnv, checkCredentials, loadConnectorConfig, PLACEHOLDER_VALUES } = require("./helpers/env");
const { PeakaClient } = require("./helpers/peakaClient");
const { discoverAllProjects, resolveDynamicConnectorConfig } = require("./helpers/peakaAccount");
const { SKIP_MARKER } = require("./helpers/preflight");
const { reapStaleServerErrorFiles } = require("./helpers/serverError");

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

// Every dashboard run currently in flight, keyed by folder id. Runs are now
// CONCURRENT: each one is its own forked child (see /api/run-stream and
// jest/runInChild.js), so several connectors can be exercised at once. What
// used to be three globals - runInProgress / currentChild / cancelRequested -
// is per-run state here instead, because with more than one run alive at a
// time a single `currentChild` would let one run's Stop kill another's
// process, and a single `cancelRequested` would mislabel an unrelated run's
// exit as cancelled.
//
// activeRuns: Map<folderId, { runId, child, send, sawDone, cancelRequested }>
const activeRuns = new Map();

// A race folder tests behaviour under deliberately manufactured concurrent
// load against Peaka itself. A sibling run hammering the same project would
// contaminate exactly what it measures, so these stay mutually exclusive with
// everything - including each other and themselves. Mirrors
// jest.races.config.js, which runs them with maxWorkers: 1 for the same
// reason.
//
// Read from each folder's own config.js (racesFor) rather than listed here,
// so adding a third race folder needs no server edit - the same principle as
// discoverConnectors() and catalogTypes.
function isExclusive(folderId) {
  return Boolean((loadConnectorConfig(folderId) || {}).racesFor);
}

function canStart(folderId) {
  if (activeRuns.has(folderId)) {
    return { ok: false, reason: `${folderId} is already running.` };
  }
  if (isExclusive(folderId) && activeRuns.size > 0) {
    return { ok: false, reason: `${folderId} needs exclusive access - another connector is currently running.` };
  }
  for (const id of activeRuns.keys()) {
    if (isExclusive(id)) {
      return { ok: false, reason: `${id} is running and needs exclusive access - try again once it finishes.` };
    }
  }
  return { ok: true };
}

const TESTS_DIR = path.join(__dirname, "tests");
const PORT = process.env.PORT || 3000;

/**
 * Live per-step events arrive here over HTTP from helpers/stepReporter.js,
 * and from jest/browserReporter.js, tagged with the runId of whichever run
 * produced them, and get forwarded onto that run's own SSE stream.
 *
 * WHY HTTP: neither can reach this process directly. Test files run inside
 * jest-runtime's sandboxed module registry, and both they and the reporter
 * now live in a forked child with its own memory, so a shared module
 * singleton would not be the same object on both ends. HTTP is the one
 * channel that works regardless. See helpers/stepReporter.js for the longer
 * note.
 *
 * ROUTED BY runId, not broadcast. Events used to be re-emitted onto a shared
 * EventEmitter that every open SSE stream listened to - fine when only one
 * run could exist, but with concurrent runs that would splice one connector's
 * steps into another connector's results. The runId is minted per run below
 * and baked into the child's PEAKA_STEP_REPORT_URL, so it can only ever match
 * the run that actually emitted it.
 */
app.post("/api/step-event", (req, res) => {
  const event = req.body;
  const runId = req.query.runId;
  if (event && typeof event.type === "string" && runId) {
    for (const run of activeRuns.values()) {
      if (run.runId === runId) {
        if (event.type === "done") run.sawDone = true;
        run.send(event);
        break;
      }
    }
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
 * - a project may well have catalogs (Pinecone, ...) this suite doesn't
 * cover yet.
 *
 * MATCHING IS DECLARED, NOT GUESSED. This used to pair a catalog with a test
 * folder by `folder.id === catalog.catalogType`, which holds only where the
 * two happen to be spelled the same. Measured live, Peaka returns
 * "peaka_postgres" and "peaka_mongodb" - so Stripe and HubSpot matched by
 * luck while real, working Postgres and MongoDB connections were reported as
 * "No test suite yet". Each folder's tests/<id>/config.js now declares its
 * own catalogTypes; the folder-id equality is kept only as a fallback for
 * any connector added later that hasn't declared one.
 *
 * Folders that need no connection at all (peaka-tables, whose tables live in
 * the built-in `peaka` catalog with a null connectionId) declare
 * requiresConnection: false and are appended for every project. Without that
 * they were unreachable from the UI entirely, since the catalog they live in
 * is filtered out as internal plumbing.
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

    const folderForCatalogType = (catalogType) =>
      testFolders.find((f) => {
        const declared = (loadConnectorConfig(f.id) || {}).catalogTypes;
        return Array.isArray(declared) ? declared.includes(catalogType) : f.id === catalogType;
      });

    const catalogs = (Array.isArray(catalogsRes.body) ? catalogsRes.body : []).filter((c) => c.connectionId); // drop internal/built-in catalogs (connectionId null/"")
    const connectors = catalogs.map((c) => {
      const folder = folderForCatalogType(c.catalogType);
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

    // Race folders, attached to whichever connector they exercise. They have
    // no catalog of their own - tests/races/ builds a throwaway Stripe
    // connection, tests/hubspot-races/ a HubSpot one - so catalog discovery
    // could never find them and both were unreachable from the UI entirely.
    // Offered only when their parent connector is actually present in this
    // project, and carrying that parent's connectionId so a run resolves the
    // same catalog/schema the parent would.
    for (const folder of testFolders) {
      const racesFor = (loadConnectorConfig(folder.id) || {}).racesFor;
      if (!racesFor) continue;
      const parent = connectors.find((c) => c.folderId === racesFor);
      if (!parent) continue;
      connectors.push({
        connectionId: parent.connectionId,
        name: folder.displayName,
        type: parent.type,
        hasTests: true,
        folderId: folder.id,
        displayName: folder.displayName,
        icon: folder.icon,
        scenarioCount: folder.scenarios.length,
        // Rendered as a companion of its parent rather than a peer - these
        // are a mode of testing an existing connection, not another one.
        companionOf: racesFor,
        // Surfaced so the UI can say WHY selecting this disables everything
        // else, instead of the button mysteriously greying out. Matches
        // EXCLUSIVE_FOLDERS in canStart().
        exclusive: true,
      });
    }

    // Connection-less folders, offered for every project. connectionId stays
    // null on purpose: resolveConnectorEnv() returns null without one, which
    // is exactly right here - these folders declare no catalog/schema env to
    // resolve (peaka-tables' requiredEnv is empty).
    for (const folder of testFolders) {
      const config = loadConnectorConfig(folder.id) || {};
      if (config.requiresConnection === false) {
        connectors.push({
          connectionId: null,
          name: folder.displayName,
          type: "internal",
          hasTests: true,
          folderId: folder.id,
          displayName: folder.displayName,
          icon: folder.icon,
          scenarioCount: folder.scenarios.length,
        });
      }
    }

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
/** A query param that arrived as the literal "null"/"undefined" is absent, not a value. */
function presentParam(v) {
  return v && v !== "null" && v !== "undefined" ? v : null;
}

async function resolveConnectorEnv(connectorId, projectId, connectionId) {
  // Belt and braces with the caller's own check: a client that stringifies a
  // missing id (encodeURIComponent(null) === "null") would otherwise get past
  // a plain truthiness test and be told its connection has no catalog, which
  // is both wrong and impossible to act on.
  projectId = presentParam(projectId);
  connectionId = presentParam(connectionId);
  if (!projectId || !connectionId) return null;
  const config = loadConnectorConfig(connectorId);
  if (!config) return null;

  const apiKey = process.env.PEAKA_API_KEY;
  if (!apiKey || PLACEHOLDER_VALUES.has(apiKey)) {
    throw new Error("PEAKA_API_KEY is not set in .env (or is still a placeholder value).");
  }

  const resolved = await resolveDynamicConnectorConfig({ apiKey, projectId, connectionId, connectorId });
  const overlay = {
    PEAKA_PROJECT_ID: projectId,
    [config.catalogIdEnv]: resolved.catalogId,
    [config.schemaEnv]: resolved.schemaName,
  };
  if (config.catalogNameEnv) overlay[config.catalogNameEnv] = resolved.catalogName;

  // A connector that reads a DIFFERENT key/project pair (Google Ads, via
  // apiKeyEnv/projectIdEnv) still gets the session's credentials here. Those
  // alternate names exist for the CLI, where one static .env has to address
  // two Peaka projects at once. The dashboard has no such problem: you
  // connected with a key and picked a project, and those are the right ones
  // by construction. Without this, opening Google Ads in the dashboard
  // demanded PEAKA_API_KEY_ADS and PEAKA_PROJECT_ID_ADS from a .env that a
  // dashboard user has no reason to have.
  if (config.projectIdEnv) overlay[config.projectIdEnv] = projectId;
  if (config.apiKeyEnv) overlay[config.apiKeyEnv] = apiKey;

  return overlay;
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

  let overlay;
  try {
    // projectId/connectionId come from the dashboard's project/connector
    // picker - see public/app.js. Resolved into a per-request overlay rather
    // than written into process.env: several connectors can now be checked
    // and run concurrently, and a shared global would let whichever request
    // resolved last decide what every other one sees.
    overlay = await resolveConnectorEnv(connectorId, req.query.projectId, req.query.connectionId);
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
  const check = checkCredentials(connectorId, overlay);
  if (check.ok) {
    res.json({ ok: true });
  } else {
    res.json({ ok: false, errors: check.errors });
  }
});

app.get("/api/run-stream", async (req, res) => {
  const folderId = req.query.folder;
  const connector = discoverConnectors().find((c) => c.id === folderId);
  if (!connector) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Unknown folder: ${folderId}` }));
    return;
  }

  const gate = canStart(folderId);
  if (!gate.ok) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: gate.reason }));
    return;
  }

  let overlay;
  try {
    // Same resolution as /api/config-status, but the result is handed to THIS
    // run's child process below rather than written into the server's own
    // process.env - two runs starting at once would otherwise overwrite each
    // other's project/catalog between resolving and forking, and one could
    // silently execute against the other's project.
    const credConnectorId = CREDENTIAL_CONNECTOR_FOR_FOLDER[folderId] || folderId;
    overlay = await resolveConnectorEnv(credConnectorId, req.query.projectId, req.query.connectionId);
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
    // A scenario gated OFF for missing data never registers under its plain
    // meta.js name - gatedTest()/gateFor() (helpers/preflight.js) append
    // " [SKIPPED: <reason>]" to the title BEFORE Jest ever sees it, so
    // test.skip's real, collected name is the mutated one. An exact `^(...)$`
    // pattern built from the plain names therefore never matches it: Jest
    // silently drops it from the run - not "runs and fails", not "runs and
    // skips" - excluded from test collection entirely, so no event of any
    // kind reaches the browser. The result was a scenario stuck as a
    // permanent, unexplained spinner that no dashboard restart could fix (a
    // real "Run All", which passes no testNamePattern at all, was never
    // affected). Allowing an optional skip suffix after each selected name is
    // what closes that gap.
    const escapedMarker = SKIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    testNamePattern = `^(${escaped.join("|")})( ${escapedMarker}.*)?$`;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Guarded: once this run's child exits (or the browser disconnects) the
  // response is ended, and a late event would otherwise throw and take the
  // whole server down with it.
  const send = (event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // This run's own identity and state. `sawDone` records whether
  // browserReporter.js's onRunComplete already fired (a NORMAL end of run -
  // passing or failing doesn't matter, Jest exits non-zero either way). Only
  // an exit we did NOT see a "done" for means something crashed. It lives on
  // the run entry rather than in a closure variable so /api/step-event can
  // set it while routing that run's events - see the handler above.
  const runId = crypto.randomUUID();
  const run = { runId, child: null, send, sawDone: false, cancelRequested: false };
  activeRuns.set(folderId, run);

  const stepReportUrl = `http://127.0.0.1:${PORT}/api/step-event?runId=${runId}`;

  // Reap only records whose owning process is gone, rather than wiping the
  // whole directory as this used to. With concurrent runs the directory holds
  // one pid file per live run, and a blanket delete here would destroy a
  // sibling run's records while it was still writing them. See
  // helpers/serverError.js.
  reapStaleServerErrorFiles();

  // Forked as its own OS process (not called in-process via runCLI, like the
  // original design) for two reasons now: so it can be KILLED (see
  // /api/cancel-run and jest/runInChild.js), and so runs can be CONCURRENT -
  // Jest's own internals are not safely re-entrant within one process, and
  // each child gets its own isolated env below. child.send()/IPC is unused on
  // purpose: live events reach this process over HTTP (stepReportUrl above),
  // so runInChild.js stays a dumb runner with no message-passing logic.
  run.child = fork(path.join(__dirname, "jest", "runInChild.js"), [], {
    cwd: __dirname,
    env: {
      ...process.env,
      // Per-child, never written into the server's own process.env - this is
      // what stops two concurrent runs resolving different projects and then
      // clobbering each other's before either forks.
      ...(overlay || {}),
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

  run.child.on("error", (err) => {
    send({ type: "fatal", message: err.message });
  });

  run.child.on("exit", (code) => {
    if (run.cancelRequested) {
      // Jest's afterAll() cleanup never ran for whatever was mid-flight -
      // real Peaka resources it had already created may still exist. Said
      // plainly in the event so the browser can warn, not hide it.
      send({
        type: "cancelled",
        message: "Run stopped. Any Peaka resources the stopped scenario had already created were NOT cleaned up (afterAll never ran) - check Peaka Studio if in doubt.",
      });
    } else if (code !== 0 && !run.sawDone) {
      // Non-zero exit is EXPECTED and normal for a run with failing tests
      // (Jest itself exits 1 then) - browserReporter.js's "done" event
      // already covers that case on its own. This branch only catches a
      // real crash: the process died before ever completing a run.
      send({ type: "fatal", message: `Test process exited unexpectedly with code ${code}` });
    }
    // Only clear the map if this is still OUR entry - guards the narrow race
    // where a fresh run for the same folder started in the gap between this
    // child exiting and this handler firing, which would otherwise evict the
    // new run rather than this one.
    if (activeRuns.get(folderId) === run) activeRuns.delete(folderId);
    res.end();
  });

  // If the browser navigates away / closes the EventSource mid-run, there's
  // no one left to show results to - stop burning real API calls/resources
  // for a run nobody's watching, same spirit as the explicit Stop button.
  // Kills only THIS run's child; sibling runs for other connectors are
  // untouched, which is the whole point of running them concurrently.
  req.on("close", () => {
    if (activeRuns.get(folderId) === run && run.child) run.child.kill();
  });
});

/**
 * Stops one run. `folder` says which - with concurrent runs there is no
 * single "current" child to kill any more, and stopping Postgres must not
 * take MongoDB down with it. Omitting it stops every run in flight, which is
 * what a "Stop all" control wants.
 */
app.post("/api/cancel-run", (req, res) => {
  const folderId = req.body && req.body.folder;

  if (!folderId) {
    if (activeRuns.size === 0) return res.json({ ok: false, error: "No run in progress." });
    const stopped = [];
    for (const [id, run] of activeRuns) {
      run.cancelRequested = true;
      if (run.child) run.child.kill();
      stopped.push(id);
    }
    return res.json({ ok: true, stopped });
  }

  const run = activeRuns.get(folderId);
  if (!run) {
    return res.json({ ok: false, error: `No run in progress for ${folderId}.` });
  }
  run.cancelRequested = true;
  run.child.kill(); // on Windows this always force-terminates; on POSIX SIGTERM is Node's default kill() signal
  res.json({ ok: true, stopped: [folderId] });
});

/** Which folders are running right now - lets a reloaded page resync its buttons. */
app.get("/api/active-runs", (req, res) => {
  res.json({ running: [...activeRuns.keys()] });
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
