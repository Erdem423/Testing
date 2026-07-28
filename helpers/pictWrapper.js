/**
 * Wrapper around the ACTUAL Microsoft PICT binary (not a reimplementation).
 *
 * The binaries in tools/pict/ are the real thing:
 *   - pict.exe    - official Microsoft-built Windows release (v3.7.4), from
 *                   https://github.com/microsoft/pict/releases/download/v3.7.4/pict.exe
 *   - pict-linux  - built from Microsoft's own source (https://github.com/microsoft/pict)
 *                   via `make pict`, for use in CI (GitHub Actions runs on ubuntu-latest)
 *
 * This module's whole job is mechanical: turn a JS object into PICT's model
 * file format, run the real binary against it, and parse its real
 * tab-separated output back into JS objects. It does no combinatorics of its
 * own - all of that happens inside the actual PICT binary.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function pictBinaryPath() {
  const dir = path.join(__dirname, "..", "tools", "pict");
  if (process.platform === "win32") {
    return path.join(dir, "pict.exe");
  }
  return path.join(dir, "pict-linux");
}

/** Builds a PICT model file's text content from a params object. */
function buildModelFileContent(params) {
  return Object.entries(params)
    .map(([name, values]) => `${name}: ${values.join(", ")}`)
    .join("\n");
}

/** Parses PICT's real tab-separated stdout into an array of row objects. */
function parsePictOutput(output) {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i];
    });
    return row;
  });
}

/**
 * Runs the REAL Microsoft PICT binary against the given parameters and
 * returns the generated combinations as an array of row objects.
 *
 * @param {Object<string, Array>} params - e.g. { Table: [...], Format: [...] }
 * @param {Object} [options]
 * @param {number} [options.seed] - passed through as PICT's own /r:N flag
 *   (real randomization built into the actual tool, not our own RNG)
 * @returns {Array<Object>} the generated rows
 */
function generateWithRealPict(params, options = {}) {
  const binaryPath = pictBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `PICT binary not found at ${binaryPath}. Expected tools/pict/pict.exe (Windows) or tools/pict/pict-linux (Linux/CI).`
    );
  }

  const modelContent = buildModelFileContent(params);
  const modelFilePath = path.join(os.tmpdir(), `pict-model-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(modelFilePath, modelContent, "utf8");

  try {
    const args = [modelFilePath];
    if (typeof options.seed === "number") {
      args.push(`/r:${options.seed}`);
    }
    const output = execFileSync(binaryPath, args, { encoding: "utf8" });
    return parsePictOutput(output);
  } finally {
    fs.unlinkSync(modelFilePath); // clean up the temp model file regardless of success/failure
  }
}

module.exports = { generateWithRealPict, buildModelFileContent, parsePictOutput, pictBinaryPath };
