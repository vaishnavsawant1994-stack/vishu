export function createSpeechPlaybackController({ synth, createUtterance, onSpeaking, onError }) {
  let generation = 0;

  function cancel() {
    generation += 1;
    synth.cancel();
    onSpeaking(false);
  }

  function speak(text) {
    const requestGeneration = generation;
    const utterance = createUtterance(text);
    utterance.onstart = () => {
      if (requestGeneration === generation) onSpeaking(true);
    };
    utterance.onend = () => {
      if (requestGeneration === generation) onSpeaking(synth.speaking);
    };
    utterance.onerror = (event) => {
      if (requestGeneration !== generation) return;
      onSpeaking(false);
      onError(event?.error);
    };
    synth.speak(utterance);
  }

  return { speak, cancel };
}
