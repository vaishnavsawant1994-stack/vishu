"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { stopBackendProcess } = require("../process.cjs");

test("Windows shutdown terminates the frozen backend and its child processes", () => {
  let invocation;
  const launcher = (exe, args, options) => {
    invocation = {exe, args, options};
    const child = new EventEmitter();
    child.unref = () => { invocation.unref = true; };
    return child;
  };
  const backend = { pid: 4321, exitCode: null, kill: () => { throw new Error("Do not kill parent alone"); } };
  assert.equal(stopBackendProcess(backend, { platform: "win32", launcher }), true);
  assert.equal(invocation.exe, "taskkill");
  assert.deepEqual(invocation.args, ["/PID", "4321", "/T", "/F"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.unref, true);
});

test("Non-Windows shutdown uses normal process termination", () => {
  let killed = false;
  assert.equal(stopBackendProcess({
    pid: 42, exitCode: null, kill: () => { killed = true; }
  }, { platform: "linux" }), true);
  assert.equal(killed, true);
  assert.equal(stopBackendProcess(null), false);
});

test("Windows taskkill launch failure falls back to parent termination", () => {
  let killed = 0;
  const backend = { pid: 81, exitCode: null, kill: () => { killed++; } };
  stopBackendProcess(backend, { platform: "win32", launcher: () => { throw new Error("taskkill missing"); } });
  assert.equal(killed, 1);
});
