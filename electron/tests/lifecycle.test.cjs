"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { registerSingleInstance } = require("../lifecycle.cjs");

test("a second VISHU launch does not acquire the singleton lock", () => {
  const events = [];
  const app = {
    requestSingleInstanceLock: () => false,
    on: (...args) => events.push(args)
  };
  assert.equal(registerSingleInstance(app, () => null), false);
  assert.deepEqual(events, []);
});

test("a second launch restores and focuses the first VISHU window", () => {
  const events = {};
  const actions = [];
  const app = {
    requestSingleInstanceLock: () => true,
    on: (name, callback) => { events[name] = callback; }
  };
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => actions.push("restore"),
    show: () => actions.push("show"),
    focus: () => actions.push("focus")
  };
  assert.equal(registerSingleInstance(app, () => window), true);
  events["second-instance"]();
  assert.deepEqual(actions, ["restore", "show", "focus"]);
});

test("singleton handler ignores a closed window or an app still starting", () => {
  let current = null;
  let handler = null;
  const app = {
    requestSingleInstanceLock: () => true,
    on: (_name, callback) => { handler = callback; }
  };
  registerSingleInstance(app, () => current);
  handler();
  current = { isDestroyed: () => true };
  handler();
});
