"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

let createSpeechPlaybackController;
test.before(async () => {
  ({ createSpeechPlaybackController } = await import("../../src/speech-playback.mjs"));
});

function makeController() {
  const utterances = [];
  const states = [];
  const errors = [];
  let cancelCount = 0;
  let speaking = false;
  const synth = {
    get speaking() { return speaking; },
    cancel() { cancelCount += 1; speaking = false; },
    speak(utterance) { utterances.push(utterance); speaking = true; }
  };
  const controller = createSpeechPlaybackController({
    synth,
    createUtterance: (text) => ({ text, onstart: null, onend: null, onerror: null }),
    onSpeaking: (value) => states.push(value),
    onError: () => errors.push("failed")
  });
  return { controller, utterances, states, errors, get cancelCount() { return cancelCount; } };
}

test("manual stop ignores the canceled utterance error", () => {
  const h = makeController();
  h.controller.speak("A longer response that can be stopped.");
  h.utterances[0].onstart();
  h.controller.cancel();
  h.utterances[0].onerror({ error: "canceled" });
  assert.deepEqual(h.states, [true, false]);
  assert.deepEqual(h.errors, []);
  assert.equal(h.cancelCount, 1);
});

test("a genuine speech engine error remains visible", () => {
  const h = makeController();
  h.controller.speak("Hello");
  h.utterances[0].onerror({ error: "synthesis-failed" });
  assert.deepEqual(h.states, [false]);
  assert.deepEqual(h.errors, ["failed"]);
});

test("stale cancellation cannot interrupt the next utterance", () => {
  const h = makeController();
  h.controller.speak("First");
  h.controller.cancel();
  h.controller.speak("Second");
  h.utterances[0].onerror({ error: "interrupted" });
  h.utterances[1].onstart();
  assert.deepEqual(h.states, [false, true]);
  assert.deepEqual(h.errors, []);
});
