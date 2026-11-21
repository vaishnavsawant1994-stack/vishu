# VISHU

**VISHU** is an independent, desktop-first personal AI assistant. This repository contains its original implementation; it is not a fork of Brahma or of any other assistant.

## Product direction

- Local-first AI conversations with explicit support for local and cloud model providers
- Real-time voice, memory, knowledge, and controlled computer/browser actions
- Expandable skills, connected devices, agents, auditability, and permission enforcement
- Windows-first desktop experience, with web and mobile support designed as separate clients

## Current milestone — Phase 1

The first vertical slice provides a secure local desktop shell, Python API, SQLite conversation history, and a real OpenAI-compatible local model connection (for example, Ollama). It must not fabricate assistant responses when no model is available.

Later phases add audio, tools, memory, devices, and autonomous workflows only behind explicit permission boundaries.

## Development

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADMAP.md](docs/ROADMAP.md) and the component READMEs for setup and acceptance criteria.

### Licensing and provenance

All VISHU code is authored independently. Brahma repositories were studied for architectural research only; restrictive Brahma Echo and Brahma Evo source code must not be copied into VISHU. A software distribution license for VISHU has not yet been selected.

### Security defaults

No committed secrets. Backend bound to loopback. Desktop session token held outside renderer process. State-changing API requests require authorization. No arbitrary shell execution, self-modifying code, or remote device control in Phase 1.
