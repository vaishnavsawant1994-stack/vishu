"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { captureSelectedScreen, registerMediaHandlers } = require("../media.cjs");

function makeHarness({ sources, responses = [0, 0] } = {}) {
  const callbacks = {};
  const dialogs = [];
  const errors = [];
  let sourceCalls = 0;
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false };
  const window = { webContents };
  const session = {
    setPermissionCheckHandler: (fn) => { callbacks.check = fn; },
    setPermissionRequestHandler: (fn) => { callbacks.permission = fn; }
  };
  const dialog = {
    showMessageBox: async (_window, options) => {
      dialogs.push(options);
      return { response: responses[dialogs.length - 1] ?? 0 };
    }
  };
  const defaultSources = ["Display 1", "VISHU window"].map((name) => ({
    name,
    thumbnail: { isEmpty: () => false, toDataURL: () => `data:image/png;base64,${name}` }
  }));
  const desktopCapturer = {
    getSources: async (options) => {
      sourceCalls += 1;
      callbacks.sourceOptions = options;
      return sources ?? defaultSources;
    }
  };
  registerMediaHandlers({ session, window, dialog, desktopCapturer,
    logError: (...args) => errors.push(args) });
  const event = { sender: webContents, senderFrame: mainFrame };
  return { callbacks, dialogs, errors, event, window, mainFrame, desktopCapturer, dialog,
    get sourceCalls() { return sourceCalls; } };
}

test("microphone permission requires the VISHU window, an audio request, and per-use consent", async () => {
  const h = makeHarness({ responses: [1] });
  assert.equal(h.callbacks.check(h.window.webContents, "media", "file://", {}), false);
  assert.equal(h.callbacks.check(null, "display-capture", "null", {}), false);
  assert.equal(h.callbacks.check(null, "unknown", "null", {}), false);

  let granted = null;
  await h.callbacks.permission(h.window.webContents, "media", (value) => { granted = value; }, { mediaTypes: ["audio"] });
  assert.equal(granted, false);
  assert.equal(h.dialogs.length, 1);

  await h.callbacks.permission(h.window.webContents, "media", (value) => { granted = value; }, { mediaTypes: ["video"] });
  assert.equal(granted, false);
  assert.equal(h.dialogs.length, 1);

  await h.callbacks.permission({ isDestroyed: () => false }, "media", (value) => { granted = value; }, { mediaTypes: ["audio"] });
  assert.equal(granted, false);
  assert.equal(h.dialogs.length, 1);
});

test("microphone permission is granted only after the explicit per-use approval", async () => {
  const h = makeHarness({ responses: [0] });
  let granted = false;
  await h.callbacks.permission(h.window.webContents, "media", (value) => { granted = value; }, { mediaTypes: ["audio"] });
  assert.equal(granted, true);
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(h.dialogs[0].buttons, ["Allow microphone", "Deny"]);
});

test("screen previews require explicit consent before capture and a second source choice", async () => {
  const h = makeHarness({ responses: [0, 1] });
  const result = await captureSelectedScreen({ event: h.event, window: h.window,
    dialog: h.dialog, desktopCapturer: h.desktopCapturer });
  assert.deepEqual(result, { image_data_url: "data:image/png;base64,VISHU window" });
  assert.equal(h.sourceCalls, 1);
  assert.deepEqual(h.callbacks.sourceOptions, {
    types: ["screen", "window"], thumbnailSize: { width: 1600, height: 900 }, fetchWindowIcons: false
  });
  assert.equal(h.dialogs.length, 2);
  assert.match(h.dialogs[0].message, /Only the image you select/);
  assert.deepEqual(h.dialogs[1].buttons, ["Display 1", "VISHU window", "Cancel"]);
});

test("screen cancellation never captures or shares an image", async () => {
  const h = makeHarness({ responses: [1] });
  const result = await captureSelectedScreen({ event: h.event, window: h.window,
    dialog: h.dialog, desktopCapturer: h.desktopCapturer });
  assert.equal(result, null);
  assert.equal(h.sourceCalls, 0);

  const declineSource = makeHarness({ responses: [0, 2] });
  const cancelled = await captureSelectedScreen({ event: declineSource.event, window: declineSource.window,
    dialog: declineSource.dialog, desktopCapturer: declineSource.desktopCapturer });
  assert.equal(cancelled, null);
  assert.equal(declineSource.sourceCalls, 1);
});

test("screen capture is main-window-only and safely handles no sources", async () => {
  const h = makeHarness({ sources: [] });
  await assert.rejects(() => captureSelectedScreen({
    event: { sender: {}, senderFrame: {} }, window: h.window,
    dialog: h.dialog, desktopCapturer: h.desktopCapturer
  }), /main window/);
  assert.equal(h.sourceCalls, 0);

  const result = await captureSelectedScreen({ event: h.event, window: h.window,
    dialog: h.dialog, desktopCapturer: h.desktopCapturer });
  assert.equal(result, null);
  assert.equal(h.sourceCalls, 1);
  assert.equal(h.dialogs.length, 1);
});
