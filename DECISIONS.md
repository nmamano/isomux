# Design Decisions (2026-03-27)

Consolidated decisions from design review. These supersede DESIGN.md where they conflict.

## Architecture

- **Single Bun process.** Serves static UI, manages agents in-process via SDK, communicates with the browser via WebSocket. No separate server/client processes.
- **No SQLite.** State is in-memory. Agent configs persist to `~/.isomux/agents.json`. Logs written to `~/.isomux/logs/` as flat files (JSON lines, one per agent session).
- **No Vite.** Bun's built-in bundler for the frontend. Manual browser refresh during dev.
- **React/SVG.** No Pixi.js. The reference UI's SVG approach is sufficient for 8 static desks with simple animations.
- **WebSocket only.** Browser connects via WebSocket. First message is a `full_state` snapshot, subsequent messages are incremental updates. No HTTP API.

## Agent SDK

- **Agent SDK V2** (`unstable_v2_createSession`). High risk tolerance — update code if API changes.
- **Subscription auth.** SDK uses the CLI's auth (tested and confirmed). No API key required.
- **Model: Opus 4.6** default. No model selection in spawn dialog for v1.
- **Permission modes:** Per-agent, chosen at spawn. SDK built-in modes only (`default`, `acceptEdits`, `bypassPermissions`). No custom permission card UI for v1.
- **Global Claude skills/MCP** inherited automatically (SDK spawns CLI which reads user's config).

## Data Model: Human vs Task

The core abstraction separates the **agent** (persistent human) from the **conversation** (ephemeral task).

### Agent (the human) — persists in `agents.json`
- name
- desk (0-7)
- outfit (deterministic from name hash; customization is a future feature)
- cwd (working directory)
- permissionMode
- lastSessionId (for auto-resume on restart)

### Conversation (the task) — in-memory, backed by SDK session
- sessionId
- state (derived from stream events)
- logEntries (full log in memory)
- SDKSession object

On server restart, agents are restored from `agents.json` and their last conversation is auto-resumed via `unstable_v2_resumeSession()`. If resume fails, agent comes back idle.

## Agent Operations

1. **Spawn** — creates a new agent at an empty desk. Spawn dialog: Name, Working directory (default: server startup dir), Permission mode.
2. **Send message** — via log view input box. Starts a new session if none active, or continues the current one.
3. **New conversation** — clears context, creates a fresh session. Same agent config.
4. **Resume** — reconnect to a past conversation (from session files on disk).
5. **Kill** — close session, remove agent from office, free the desk.

## UI

- **Office view:** Isometric grid, 2x4 = 8 desks. Click agent → log view. Click empty desk → spawn dialog. Right-click agent → context menu (new conversation, resume, kill).
- **Log view:** Structured message cards — assistant text as markdown, tool calls as collapsible blocks, thinking as dimmed/collapsible, errors in red. Input box at bottom.
- **Monitor preview:** Short snippet of latest agent output on the desk monitor.
- **Notifications:** Visual badge/pulse on desk always. Sound notification when browser tab is unfocused.
- **Reference UI (`reference_ui.jsx`):** Treated as a visual spec, not code to refactor. Rebuild from it as needed.

## What's NOT in v1

- Cost badges (irrelevant with subscription)
- Model selection per agent
- Outfit customization
- Auto mode (not available on individual plans or in SDK yet)
- Agent-to-agent communication
- Remote agents
- CLI-based agent spawning
- `agents.toml` config file
- Audio beyond notification sounds

## Build Order (revised)

1. Project setup (package.json, tsconfig, Bun bundler config)
2. Shared types (agent, conversation, WebSocket messages)
3. Server (Bun HTTP + WebSocket, agent registry, SDK session management)
4. Minimal UI (static office view with desks, spawn dialog, WebSocket connection)
5. Log view (structured messages, input box, streaming)
6. Polish (notifications, context menu, monitor preview, resume)
