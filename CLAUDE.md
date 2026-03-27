# Claude Office

An isometric 2D office UI for managing multiple concurrent Claude Code agents. Each agent sits at a desk, has a unique outfit, and visually reflects its current state (working, waiting, idle). Built on Bun, runs locally.

## Architecture

**Three components connected by WebSocket:**

1. **Office Server** (Bun) — Serves the UI, maintains agent registry in SQLite, routes messages between clients and browsers. Knows nothing about agent runtimes.
2. **Client(s)** — Thin wrappers around agent runtimes (Claude Code Agent SDK for v1). Speak a runtime-agnostic protocol over WebSocket. Can be local or remote.
3. **Office UI** (Browser) — Pixi.js isometric office + React log view.

```
Browser ↔ WebSocket ↔ Office Server ↔ WebSocket ↔ Client(s)
                          ↕
                       SQLite
```

The key design decision: **clients and the server are decoupled via a protocol**. The server doesn't know or care whether a client wraps Claude Code, Codex, or anything else. This means remote agents aren't special — they just connect from a different machine.

Read `DESIGN.md` for full protocol spec, data model, SDK integration details, and implementation notes.

## Tech Stack

- **Runtime**: Bun
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` (TypeScript)
- **Office rendering**: Pixi.js (isometric sprites, WebGL)
- **Log view / UI chrome**: React (only for the non-canvas parts)
- **Persistence**: SQLite via `bun:sqlite`
- **WebSocket**: Bun native
- **Terminal**: None. Agents run headless via SDK. No xterm.js, no PTY.

## Key Decisions (Do Not Revisit)

- We are NOT reimplementing the agent harness. Claude Code handles the agent loop.
- We are NOT implementing a terminal. Agents are headless SDK sessions. The expanded view is a structured log, not a terminal.
- Sprites/art are handled separately. Don't generate or stub sprite art.
- 8 desks max (fixed grid, not customizable for v1).
- No audio for v1 except notification sounds.
- No agent-to-agent communication.
- All log history is kept forever in SQLite. Nothing is thrown out.
- The V2 session API (`unstable_v2_createSession`) is the target for multi-turn. Fall back to V1 `continue: true` if V2 is too unstable.
- Permission handling uses `canUseTool` callback which blocks until user responds via the UI.
- Agent idle = waiting for user to send next message. User manually stops agents when done.
- Error states: reasonable defaults. Agent crashes → show error state, offer restart. Disconnected client → show error state, auto-reconnect when client returns.

## Build Order

1. Protocol types (shared between server and client)
2. Office server (WebSocket hub, SQLite, event routing)
3. Claude Code client (SDK integration, permission bridge)
4. Minimal office UI (Pixi.js scene, desks, state-driven placeholder visuals)
5. Log view (React, scrollback, streaming, input box, permission/question cards)
6. Polish (spawn dialog, context menu, cost badges, notifications, config file)
7. Remote client support (test protocol over non-localhost)

Phases 1-3 can be tested from terminal only (log events to console). Phase 4 can use colored rectangles instead of real sprites. Engineering and art are fully parallelizable.

## Project Structure

```
claude-office/
├── CLAUDE.md
├── DESIGN.md
├── package.json
├── server/
│   ├── index.ts              # entry point, WebSocket hub, static file serving
│   ├── db.ts                 # SQLite schema + queries
│   ├── registry.ts           # agent registry logic
│   └── outfit.ts             # deterministic outfit generation from name hash
├── client/
│   ├── claude-code-client.ts # Agent SDK wrapper → protocol adapter
│   └── cli.ts                # `claude-office add` CLI entry point
├── shared/
│   └── protocol.ts           # ClientEvent, ServerCommand, all shared types
├── ui/
│   ├── index.html
│   ├── office/               # Pixi.js isometric renderer
│   ├── log-view/             # React: expanded agent conversation view
│   ├── components/           # React: dialogs, menus, toasts
│   ├── store.ts              # client-side state
│   └── ws.ts                 # WebSocket connection to server
└── config/
    └── agents.toml           # optional persistent agent config
```
