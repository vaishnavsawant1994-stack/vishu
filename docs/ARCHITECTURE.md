# VISHU architecture and threat boundaries

## Phase 1 components
- Electron main process: starts local Python API, generates a random per-session token, constrains renderer IPC to known API routes, owns local data directory.
- Electron preload: only exposes a minimal request bridge via contextBridge.
- React/Vite renderer: UI, conversation selection, sending messages and rendering real responses. It never receives the backend token.
- FastAPI: loopback-only API. Any conversation/chat operation requires a bearer token. Authentication is checked independently of model instructions.
- SQLite: userData/vishu.sqlite3 in the Electron app; creates conversations and messages with foreign keys and local persistence.
- Model adapter: OpenAI-compatible completions, defaulting to local Ollama. It returns an explicit 503 when unavailable and does not insert false success messages.

## Communication
Renderer --restricted IPC--> Electron main --Bearer token--> 127.0.0.1 FastAPI --OpenAI-compatible request--> Model.

## Current boundaries
- Loopback API and bearer token are defense in depth; no remote API endpoints are supported.
- No model-authorized shell or filesystem tools are connected.
- Never put provider API credentials into renderer JavaScript, Git history, or model memories.
- Messages are plaintext in a local SQLite DB for this initial vertical slice; disk encryption and backup/export need their own acceptance work.
- Development uses source Python and Electron. Windows packaging freezes the API with PyInstaller and bundles it as an Electron resource; the NSIS installer is currently unsigned.

## Planned modules
AI Orchestrator / Model Router / Memory & Knowledge / Policy & Consent Broker / Tool Registry / Isolated Workers / Device Gateway / Event Audit & Rollback / Voice pipeline.

## External-source policy
VISHU is independently authored. Third-party Brahma code is not included. Design patterns are research inputs, not authorization to redistribute source-available code.

## Tests
The Python tests inject a deterministic model test double and use a disposable SQLite database. They do not claim that Ollama or a cloud model has been tested in production. CI separately compiles and builds the frontend.
