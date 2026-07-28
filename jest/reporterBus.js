/**
 * A shared event bus between jest/browserReporter.js and server.js.
 *
 * Passing a live function through Jest's runCLI() config doesn't work -
 * config gets JSON-serialized internally (mirroring how --config works as a
 * CLI flag), and JSON.stringify silently drops function properties. Since
 * the reporter and server.js both run in the SAME Node process (server.js
 * calls runCLI() directly, with runInBand:true), a plain Node module - which
 * Node caches as a singleton per process - works as a reliable shared
 * channel instead.
 */
const { EventEmitter } = require("events");

module.exports = new EventEmitter();
