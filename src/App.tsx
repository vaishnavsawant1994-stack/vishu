import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { request, type ChatMessage, type Conversation, type Health } from "./api";
import { createSpeechPlaybackController } from "./speech-playback.mjs";

function shortDate(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : new Date(time).toLocaleDateString(undefined, {
    month: "short", day: "numeric"
  });
}

export default function App() {
  const [items, setItems] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const [model, setModel] = useState("Not configured");
  const [visionModel, setVisionModel] = useState("Not configured");
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [attachment, setAttachment] = useState<{name: string; content: string} | null>(null);
  const [screenQuestion, setScreenQuestion] = useState("What is on my screen?");
  const [screenPreview, setScreenPreview] = useState<string | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const [windowsApp, setWindowsApp] = useState<"notepad" | "calculator" | "explorer">("notepad");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const endOfMessages = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);
  const activeStreamRef = useRef<string | null>(null);
  const streamFailureRef = useRef("");
  const completedConversationRef = useRef("");
  const speechBufferRef = useRef("");
  const speechPlaybackRef = useRef<ReturnType<typeof createSpeechPlaybackController> | null>(null);

  function speechPlayback() {
    if (!speechPlaybackRef.current) {
      speechPlaybackRef.current = createSpeechPlaybackController({
        synth: window.speechSynthesis,
        createUtterance: (text) => new SpeechSynthesisUtterance(text),
        onSpeaking: setSpeaking,
        onError: (reason) => setError(reason
          ? `System speech playback failed (${reason}). Check that a Windows speech voice is installed.`
          : "System speech playback failed. Check that a Windows speech voice is installed.")
      });
    }
    return speechPlaybackRef.current;
  }

  useEffect(() => {
    (async () => {
      try {
        const health = await request<Health>("GET", "/api/health");
        setOnline(health.status === "ok");
        setModel(health.configured_model);
        setVisionModel(health.vision_model || health.configured_model);
        const conversations = await request<Conversation[]>("GET", "/api/conversations");
        setItems(conversations);
      } catch (cause) {
        setOnline(false);
        setError(cause instanceof Error ? cause.message : "Could not connect to VISHU.");
      }
    })();
  }, []);

  useEffect(() => {
    endOfMessages.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, streamingAssistant]);

  useEffect(() => {
    const unsubscribe = window.vishu?.onChatStream((event) => {
      if (event.streamId !== activeStreamRef.current) return;
      if (event.type === "delta" && event.text) {
        setStreamingAssistant((current) => current + event.text);
        queueStreamSpeech(event.text);
      } else if (event.type === "error") {
        streamFailureRef.current = event.message || "The model stream failed.";
      } else if (event.type === "done" && event.conversation_id) {
        completedConversationRef.current = event.conversation_id;
      }
    });
    return () => unsubscribe?.();
  }, []);

  async function refresh() {
    setItems(await request<Conversation[]>("GET", "/api/conversations"));
  }

  async function openConversation(id: string) {
    if (busy) return;
    selectedRef.current = id;
    setSelected(id);
    setPending(null);
    setError("");
    try {
      const next = await request<ChatMessage[]>(
        "GET", "/api/conversations/" + id + "/messages"
      );
      if (selectedRef.current === id) {
        setMessages(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load conversation.");
    }
  }

  function newConversation() {
    if (busy) return;
    selectedRef.current = null;
    setSelected(null);
    setMessages([]);
    setPending(null);
    setError("");
    setDraft("");
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setError("");
    setBusy(true);
    setPending(text);
    setStreamingAssistant("");
    streamFailureRef.current = "";
    completedConversationRef.current = "";
    speechBufferRef.current = "";
    setDraft("");
    stopSpeech();
    const streamId = crypto.randomUUID();
    activeStreamRef.current = streamId;
    try {
      const result = await window.vishu?.chatStream(streamId, {
        text: attachment
          ? text + "\n\n[User-selected file: " + attachment.name + "]\n" + attachment.content + "\n[End of file]"
          : text,
        conversation_id: selected
      });
      if (result?.cancelled) return;
      if (streamFailureRef.current) throw new Error(streamFailureRef.current);
      if (!result?.complete || !completedConversationRef.current) {
        throw new Error("VISHU ended the response stream before completion.");
      }
      finishStreamSpeech();
      selectedRef.current = completedConversationRef.current;
      setSelected(completedConversationRef.current);
      const next = await request<ChatMessage[]>(
        "GET", "/api/conversations/" + completedConversationRef.current + "/messages"
      );
      setMessages(next);
      setAttachment(null);
      await refresh();
    } catch (cause) {
      if (activeStreamRef.current === streamId) {
        setError(cause instanceof Error ? cause.message : "The model request failed.");
        setDraft(text);
      }
    } finally {
      if (activeStreamRef.current === streamId) {
        activeStreamRef.current = null;
        setPending(null);
        setStreamingAssistant("");
        setBusy(false);
      }
    }
  }

  function queueStreamSpeech(text: string) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
    speechBufferRef.current += text;
    const boundary = Math.max(
      speechBufferRef.current.lastIndexOf(". "),
      speechBufferRef.current.lastIndexOf("? "),
      speechBufferRef.current.lastIndexOf("! "),
      speechBufferRef.current.lastIndexOf("\n")
    );
    const cut = boundary >= 0 ? boundary + 1 : speechBufferRef.current.length >= 220
      ? speechBufferRef.current.lastIndexOf(" ", 200) : -1;
    if (cut <= 0) return;
    const part = speechBufferRef.current.slice(0, cut).trim();
    speechBufferRef.current = speechBufferRef.current.slice(cut).trimStart();
    if (part) enqueueSpeech(part);
  }

  function enqueueSpeech(text: string) {
    speechPlayback().speak(text);
  }

  function finishStreamSpeech() {
    const remainder = speechBufferRef.current.trim();
    speechBufferRef.current = "";
    if (remainder && "speechSynthesis" in window) enqueueSpeech(remainder);
  }

  function stopResponse() {
    const streamId = activeStreamRef.current;
    if (!streamId) return;
    activeStreamRef.current = null;
    window.vishu?.cancelStream(streamId);
    if ("speechSynthesis" in window) speechPlayback().cancel();
    speechBufferRef.current = "";
    setSpeaking(false);
    setPending(null);
    setStreamingAssistant("");
    setBusy(false);
    setError("Response stopped. The incomplete turn was not saved.");
  }

  async function chooseFile() {
    try {
      const selectedFile = await window.vishu?.openTextFile();
      if (selectedFile) setAttachment(selectedFile);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that file.");
    }
  }

  function stopSpeech() {
    if ("speechSynthesis" in window) speechPlayback().cancel();
  }

  async function openSelectedText() {
    try {
      const result = await window.vishu?.openSelectedText();
      if (result?.opened) setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Windows could not open that file.");
    }
  }

  async function openWindowsApplication() {
    setError("");
    try {
      const result = await window.vishu?.launchApplication(windowsApp);
      if (result?.launched) setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Windows application launch failed.");
    }
  }

  function playSpeech(text: string) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setError("System speech playback is unavailable in this environment.");
      return;
    }
    const playback = speechPlayback();
    playback.cancel();
    playback.speak(text);
  }

  function wavBase64(buffer: AudioBuffer): string {
    const samples = buffer.getChannelData(0);
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const write = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE");
    write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    let binary = "";
    const data = new Uint8Array(bytes);
    for (let offset = 0; offset < data.length; offset += 0x8000) {
      binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function recordAndTranscribe() {
    if (recording && recorderRef.current) {
      recorderRef.current.stop();
      setRecording(false);
      return;
    }
    setError("");
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      let recordingTimer = 0;
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        window.clearTimeout(recordingTimer);
        stream?.getTracks().forEach((track) => track.stop());
        setRecording(false);
        setVoiceBusy(true);
        try {
          const audioContext = new AudioContext();
          const source = await audioContext.decodeAudioData(await new Blob(chunks).arrayBuffer());
          await audioContext.close();
          const context = new OfflineAudioContext(1, Math.ceil(source.duration * 16000), 16000);
          const node = context.createBufferSource();
          node.buffer = source;
          node.connect(context.destination);
          node.start();
          const mono = await context.startRendering();
          const result = await request<{text: string}>("POST", "/api/transcribe", {audio_wav_base64: wavBase64(mono)});
          setDraft((current) => current ? `${current} ${result.text}` : result.text);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Offline speech recognition failed.");
        } finally { setVoiceBusy(false); }
      };
      recorder.start();
      recordingTimer = window.setTimeout(() => recorder.stop(), 60_000);
      setRecording(true);
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      setError(cause instanceof Error ? cause.message : "Microphone access was denied.");
    }
  }

  async function understandScreen() {
    setError("");
    try {
      const capture = await window.vishu?.captureScreen();
      if (!capture) return;
      // Never upload the captured image until the user reviews it and confirms.
      setScreenPreview(capture.image_data_url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screen capture failed.");
    }
  }

  async function confirmScreenShare() {
    if (!screenPreview || screenBusy) return;
    setScreenBusy(true);
    setError("");
    try {
      const result = await request<{answer: string}>("POST", "/api/screen", {
        image_data_url: screenPreview,
        question: screenQuestion
      });
      setMessages((current) => [...current, {
        id: "screen:" + crypto.randomUUID(), role: "assistant", content: result.answer,
        created_at: new Date().toISOString()
      }]);
      setScreenPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screen understanding failed.");
    } finally {
      setScreenBusy(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  async function removeConversation(item: Conversation) {
    if (busy || !window.confirm("Delete this conversation and its local messages?")) return;
    try {
      await request<{deleted: boolean}>(
        "DELETE", "/api/conversations/" + item.id
      );
      if (selected === item.id) newConversation();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete conversation.");
    }
  }

  const selectedTitle = selected
    ? items.find((item) => item.id === selected)?.title || "Conversation"
    : "New conversation";

  return (
    <div className="shell">
      <aside className="sidebar">
        <header className="brand">
          <span className="brand-icon" aria-hidden="true"><span /></span>
          <span className="brand-text">VISHU <small>PERSONAL INTELLIGENCE</small></span>
        </header>
        <button className="new-chat" type="button" onClick={newConversation} disabled={busy}>
          <span aria-hidden="true">＋</span> New conversation
        </button>
        <div className="section-heading">CONVERSATIONS</div>
        <nav className="conversation-list" aria-label="Conversation history">
          {items.length === 0 && (
            <p className="sidebar-empty">Your conversations will appear here.</p>
          )}
          {items.map((item) => (
            <div key={item.id} className={"conversation-item " + (selected === item.id ? "selected" : "")}>
              <button type="button" className="conversation-open" onClick={() => void openConversation(item.id)}
                aria-current={selected === item.id ? "page" : undefined} disabled={busy}>
                <span className="conversation-name">{item.title}</span>
                <small>{shortDate(item.updated_at)}</small>
              </button>
              <button className="delete-chat" type="button" onClick={() => void removeConversation(item)}
                title={"Delete " + item.title} aria-label={"Delete " + item.title} disabled={busy}>×</button>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={"status-indicator " + (online ? "connected" : "")} />
          <div>
            <strong>{online ? "Local API online" : "API disconnected"}</strong>
            <small>Chat: {model} · Vision: {visionModel}</small>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="eyebrow">WORKSPACE / CHAT</span>
            <strong>{selectedTitle}</strong>
          </div>
          <div className="topbar-chip"><span className="chip-dot" /> PHASE 2 · LOCAL</div>
        </header>

        <div className="conversation-area" aria-live="polite">
          {messages.length === 0 && !pending ? (
            <section className="welcome">
              <div className="orb" aria-hidden="true"><div className="orb-inner" /></div>
              <span className="eyebrow">YOUR PERSONAL INTELLIGENCE</span>
              <h1>Meet VISHU.</h1>
              <p>A dedicated AI workspace built for real work, meaningful context, and your control.</p>
              <div className="welcome-note">
                VISHU connects to your configured model. Microphone transcription runs with an
                installed offline Vosk model; screen viewing and text-file sharing always require your action.
              </div>
            </section>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <div key={message.id} className={"message-row " + message.role}>
                  <div className="message-avatar">{message.role === "user" ? "YOU" : "V"}</div>
                  <div className="message-content">
                    <div className="message-name">{message.id.startsWith("screen:") ? "VISHU · Temporary screen analysis (not saved)" : message.role === "user" ? "You" : "VISHU"}</div>
                    <div className="message-text">{message.content}</div>
                    {message.role === "assistant" && <button className="speak-message" type="button" onClick={() => playSpeech(message.content)}>Play voice</button>}
                  </div>
                </div>
              ))}
              {pending && (
                <div className="message-row user pending">
                  <div className="message-avatar">YOU</div>
                  <div className="message-content">
                    <div className="message-name">You · Sending</div>
                    <div className="message-text">{pending}</div>
                  </div>
                </div>
              )}
              {streamingAssistant && (
                <div className="message-row assistant">
                  <div className="message-avatar">V</div>
                  <div className="message-content">
                    <div className="message-name">VISHU · Responding</div>
                    <div className="message-text">{streamingAssistant}</div>
                  </div>
                </div>
              )}
              <div ref={endOfMessages} />
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {error && (
            <div className="error-message" role="alert">
              <span>{error}</span>
              <button onClick={() => setError("")} type="button" aria-label="Dismiss error">×</button>
            </div>
          )}
          <form className="composer" onSubmit={(event) => void send(event)}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Message VISHU..."
              aria-label="Message VISHU"
              rows={2}
              disabled={busy}
              maxLength={10000}
            />
            <button className="send-button" type="submit" disabled={busy || !draft.trim()}
              aria-label="Send message">
              {busy ? "···" : "↑"}
            </button>
          </form>
          <div className="tools-row" aria-label="Voice and computer tools">
            <button type="button" onClick={() => void recordAndTranscribe()} disabled={voiceBusy || busy}>
              {recording ? "Stop recording" : voiceBusy ? "Transcribing…" : "🎙 Voice input"}
            </button>
            <button type="button" onClick={() => void chooseFile()} disabled={busy}>Attach text file</button>
            <button type="button" onClick={() => void openSelectedText()} disabled={busy}>Open text file…</button>
            <select value={windowsApp} onChange={(event) => setWindowsApp(event.target.value as "notepad" | "calculator" | "explorer")} aria-label="Approved Windows application" disabled={busy}>
              <option value="notepad">Notepad</option>
              <option value="calculator">Calculator</option>
              <option value="explorer">File Explorer</option>
            </select>
            <button type="button" onClick={() => void openWindowsApplication()} disabled={busy}>Open app…</button>
            <input aria-label="Question about screen" value={screenQuestion} onChange={(event) => setScreenQuestion(event.target.value)} maxLength={500} />
            <button type="button" onClick={() => void understandScreen()} disabled={busy || screenBusy}>Share screen…</button>
            {busy && <button type="button" onClick={stopResponse}>Stop response</button>}
            {speaking && !busy && <button type="button" onClick={stopSpeech}>Stop speaking</button>}
          </div>
          {attachment && <div className="attachment-note">Selected: {attachment.name} <button type="button" onClick={() => setAttachment(null)}>Remove</button></div>}
          <p className="composer-caption">
            {busy ? "Streaming from the configured AI model… Stop response cancels generation and speech." :
              "VISHU does not invent AI responses. Enter to send · Shift+Enter for a new line"}
          </p>
        </div>
      </main>
      {screenPreview && (
        <div className="screen-preview-overlay">
          <section className="screen-preview-panel" role="dialog" aria-modal="true" aria-label="Review screen before sharing">
            <h2>Review the selected screen</h2>
            <p>The image below stays in VISHU until you approve sending this one still frame to your configured vision model.</p>
            <img src={screenPreview} alt="Selected screen or window capture awaiting your approval" />
            <div className="screen-preview-question"><strong>Question:</strong> {screenQuestion}</div>
            <div className="screen-preview-actions">
              <button type="button" autoFocus onClick={() => setScreenPreview(null)} disabled={screenBusy}>Cancel · do not share</button>
              <button type="button" onClick={() => void confirmScreenShare()} disabled={screenBusy}>
                {screenBusy ? "Analyzing…" : "Confirm and send to vision model"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
