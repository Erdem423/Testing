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
const { runCLI } = require("jest");
const { loadDotEnv, checkCredentials } = require("./helpers/env");
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
app.use(express.static(path.join(__dirname, "public")));

let runInProgress = false;

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

app.get("/api/config-status", (req, res) => {
  // Deliberately reuse the exact same credential check Jest itself will run -
  // see helpers/env.js. This is just an early, friendlier warning before the
  // user clicks "Run tests" and Jest fails on every test with the same message.
  const check = checkCredentials();
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

  // Listen on the shared bus for the duration of this run only - the
  // reporter (running inside the same process, via runInBand:true) emits
  // events here as each test completes. See jest/reporterBus.js for why a
  // shared module is used instead of passing a callback through Jest's
  // (JSON-serialized) config, which silently drops functions.
  const onBusEvent = (event) => send(event);
  reporterBus.on("event", onBusEvent);

  runInProgress = true;
  // Tells helpers/stepReporter.js where to POST live step events. Set only
  // for dashboard-launched runs, so a plain `npm test` stays a no-op.
  process.env.PEAKA_STEP_REPORT_URL = `http://127.0.0.1:${PORT}/api/step-event`;

  // Clear per-run server-error records. jest.globalSetup.js does this too, but
  // the runCLI config below deliberately does NOT include globalSetup - so
  // without this line a dashboard run would leave records behind that the next
  // `npm test` would report as phantom warnings.
  try {
    fs.rmSync(SERVER_ERROR_DIR, { recursive: true, force: true });
  } catch (_) {
    // Reporting hygiene only - never worth failing a run over.
  }
  try {
    await runCLI(
      {
        // Same project config (jest.config.js) plus our streaming reporter
        // added alongside the normal ones - junit.xml still gets written.
        // testMatch is scoped to THIS folder's jest/<id>/ directory, so
        // running the Stripe folder never touches another connector's tests.
        // No functions in here - everything is plain strings/arrays, so
        // JSON-serializing this config (which runCLI does internally) is safe.
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
        runInBand: true, // keep everything in THIS process so the reporter's bus emits are visible here
        ...(testNamePattern ? { testNamePattern } : {}),
      },
      [__dirname]
    );
  } catch (err) {
    send({ type: "fatal", message: err.message });
  } finally {
    reporterBus.off("event", onBusEvent);
    delete process.env.PEAKA_STEP_REPORT_URL;
    runInProgress = false;
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Peaka Test dashboard running at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
