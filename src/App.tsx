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
        text,
        conversation_id: selected
      });
      selectedRef.current = response.conversation_id;
      setSelected(response.conversation_id);
      const next = await request<ChatMessage[]>(
        "GET", "/api/conversations/" + response.conversation_id + "/messages"
      );
      setMessages(next);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The model request failed.");
      setDraft(text);
    } finally {
      setPending(null);
      setBusy(false);
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
          <div className="topbar-chip"><span className="chip-dot" /> PHASE 1 · LOCAL</div>
        </header>

        <div className="conversation-area" aria-live="polite">
          {messages.length === 0 && !pending ? (
            <section className="welcome">
              <div className="orb" aria-hidden="true"><div className="orb-inner" /></div>
              <span className="eyebrow">YOUR PERSONAL INTELLIGENCE</span>
              <h1>Meet VISHU.</h1>
              <p>A dedicated AI workspace built for real work, meaningful context, and your control.</p>
              <div className="welcome-note">
                This first version connects to a real local AI model. Start Ollama and install
                your configured model before chatting. Voice and device actions come in later phases.
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
          <p className="composer-caption">
            {busy ? "Waiting for the configured AI model..." :
              "VISHU does not invent AI responses. Enter to send · Shift+Enter for a new line"}
          </p>
        </div>
      </main>
    </div>
  );
}
