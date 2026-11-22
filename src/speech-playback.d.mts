export function createSpeechPlaybackController(options: {
  synth: SpeechSynthesis;
  createUtterance: (text: string) => SpeechSynthesisUtterance;
  onSpeaking: (speaking: boolean) => void;
  onError: (reason?: string) => void;
}): {
  speak(text: string): void;
  cancel(): void;
};
