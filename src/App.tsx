import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { request, type ChatMessage, type ChatResponse, type Conversation, type Health } from "./api";

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
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [attachment, setAttachment] = useState<{name: string; content: string} | null>(null);
  const [screenQuestion, setScreenQuestion] = useState("What is on my screen?");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const endOfMessages = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const health = await request<Health>("GET", "/api/health");
        setOnline(health.status === "ok");
        setModel(health.configured_model);
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
  }, [messages, pending]);

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
    setDraft("");
    try {
      const response = await request<ChatResponse>("POST", "/api/chat", {
        text: attachment
          ? `${text}\n\n[User-selected file: ${attachment.name}]\n${attachment.content}\n[End of file]`
          : text,
        conversation_id: selected
      });
      selectedRef.current = response.conversation_id;
      setSelected(response.conversation_id);
      const next = await request<ChatMessage[]>(
        "GET", "/api/conversations/" + response.conversation_id + "/messages"
      );
      setMessages(next);
      setAttachment(null);
      playSpeech(response.assistant);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The model request failed.");
      setDraft(text);
    } finally {
      setPending(null);
      setBusy(false);
    }
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
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }

  function playSpeech(text: string) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setError("System speech playback is unavailable in this environment.");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => {
      setSpeaking(false);
      setError("System speech playback failed or no speech voice is available.");
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
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
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: false});
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(video.videoWidth, 1600);
      canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      const image_data_url = canvas.toDataURL("image/png");
      const result = await request<{answer: string}>("POST", "/api/screen", {image_data_url, question: screenQuestion});
      setMessages((current) => [...current, {id: crypto.randomUUID(), role: "assistant", content: result.answer, created_at: new Date().toISOString()}]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screen capture or image understanding failed.");
    } finally { stream?.getTracks().forEach((track) => track.stop()); }
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
            <small>Model: {model}</small>
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
                    <div className="message-name">{message.role === "user" ? "You" : "VISHU"}</div>
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
            <input aria-label="Question about screen" value={screenQuestion} onChange={(event) => setScreenQuestion(event.target.value)} maxLength={500} />
            <button type="button" onClick={() => void understandScreen()} disabled={busy}>Share screen…</button>
            {speaking && <button type="button" onClick={stopSpeech}>Stop speaking</button>}
          </div>
          {attachment && <div className="attachment-note">Selected: {attachment.name} <button type="button" onClick={() => setAttachment(null)}>Remove</button></div>}
          <p className="composer-caption">
            {busy ? "Waiting for the configured AI model..." :
              "VISHU does not invent AI responses. Enter to send · Shift+Enter for a new line"}
          </p>
        </div>
      </main>
    </div>
  );
}
