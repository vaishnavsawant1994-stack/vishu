# VISHU delivery roadmap

This is an execution roadmap, not a claim that features are already working.

## Phase 1 — Desktop and AI foundation (accepted)
- [x] Repository initialization and independent architecture decision
- [x] Loopback-only desktop backend with session authorization
- [x] Real model request integration via OpenAI-compatible API
- [x] SQLite conversations and chat history
- [x] Electron/React desktop interface with chat functionality
- [x] Automated backend/API tests and CI configuration
- [x] Real Windows desktop acceptance with Ollama installed
- [x] Frontend build and desktop launch validated by CI and Windows smoke tests
- [x] Installer and packaging (unsigned; model setup remains manual)

## Phase 2 — Voice and computer (features implemented; device acceptance pending)
- [x] Offline microphone transcription through Vosk with explicit missing-model errors
- [x] System speech playback with stop control
- [x] User-selected still-screen capture routed to a configured vision-capable model
- [x] Native-dialog, read-only text-file sharing with extension and size limits
- [x] Model response streaming with cancellation propagated to the model request
- [x] Incremental system speech playback with stop and replay controls
- [x] Constrained user-selected text-file opening with per-action consent and a local audit log
- [ ] Packaged desktop acceptance with a physical microphone and configured offline speech model
- [ ] Screen chooser and screen understanding acceptance with a configured vision-capable model

Arbitrary shell commands, file modification, and model-initiated Windows actions remain out of scope. The one Windows action above can only open a user-selected small text file after native confirmation.

## Phase 3 — Memory and intelligence
Inspectable second brain, citations, project knowledge, model routing, planning.

## Phase 4 — Autonomous workflows
Browser control, MCP permissions, task scheduler, specialized agents, isolated skills.

## Phase 5 — Connected devices
Mutually authenticated device enrollment, encrypted transport, consent controls.

## Phase 6 — Production acceptance
Accessibility, security hardening, migration and backup testing, CI, cross-platform qualification.

## Definition of done
A feature is complete only if implemented, integrated, tested, observable, secure at its execution boundary, and accepted on a real target device. Do not label a README feature claim as working without verification.
