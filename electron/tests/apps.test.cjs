"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { resolveApplication, launchAllowedApplication } = require("../apps.cjs");

test("Windows actions accept only known application IDs", () => {
  assert.equal(resolveApplication("notepad").executable, "notepad.exe");
  assert.equal(resolveApplication("calculator").executable, "calc.exe");
  assert.equal(resolveApplication("explorer").executable, "explorer.exe");
  for (const id of [null, "", "../cmd", "cmd.exe", "powershell", "notepad --flag", {}, 42]) {
    assert.equal(resolveApplication(id), null);
  }
});

test("Windows app launch passes an executable with zero arguments and without shell", async () => {
  let command;
  let args;
  let options;
  let unrefCount = 0;
  const launcher = (exe, argv, settings) => {
    command = exe;
    args = argv;
    options = settings;
    const child = new EventEmitter();
    child.unref = () => { unrefCount++; };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const result = await launchAllowedApplication("notepad", { platform: "win32", launcher });
  assert.deepEqual(result, { launched: true });
  assert.equal(command, "notepad.exe");
  assert.deepEqual(args, []);
  assert.equal(options.shell, false);
  assert.equal(unrefCount, 1);
});

test("Windows app launch rejects unlisted commands and non-Windows platforms", async () => {
  const badLauncher = () => { throw new Error("Must never spawn an unapproved executable"); };
  await assert.rejects(
    launchAllowedApplication("cmd.exe", { platform: "win32", launcher: badLauncher }),
    /not allowed/
  );
  await assert.rejects(
    launchAllowedApplication("notepad", { platform: "linux", launcher: badLauncher }),
    /not allowed/
  );
});

test("Windows app launch reports failed process creation", async () => {
  const launcher = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("Windows executable missing")));
    return child;
  };
  await assert.rejects(
    launchAllowedApplication("notepad", { platform: "win32", launcher }),
    /Windows executable missing/
  );
});
