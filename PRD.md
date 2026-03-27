# PRD: Isomux — Isometric Office for Managing Concurrent Claude Code Agents

## Problem Statement

Developers using Claude Code often need multiple agents working concurrently on different tasks — reviewing a PR, implementing a feature, debugging a test, etc. Today this means juggling multiple terminal windows or tabs, each running a separate Claude Code session. There's no unified view of what each agent is doing, no way to see at a glance who's working, who's stuck, and who needs input. The cognitive load scales linearly with the number of agents.

## Solution

Isomux is a local desktop app (Bun + browser) that presents a persistent **isometric 2D office** where up to 8 Claude Code agents sit at desks. Each agent is a named character with a unique appearance, working in a designated project directory. The office view shows all agents at once — you see who's typing, who's idle, who's erroring — without switching windows. Click an agent to open a structured conversation view. The metaphor is: "This is my team. I'm going to ask Samantha to implement feature X in project Y."

The key abstraction is **human (agent) vs task (conversation)**. Agents persist — they have names, desks, outfits, and working directories. Conversations are ephemeral — they start, they end, they can be resumed. You hire an agent once; you give them tasks over time.

## User Stories

1. As a developer, I want to see all my agents in a single isometric office view, so that I can monitor their status at a glance without switching between terminals.
2. As a developer, I want each agent to have a unique name and appearance, so that I can quickly identify who's who in the office.
3. As a developer, I want to click an empty desk to spawn a new agent, so that adding an agent to my team is intuitive.
4. As a developer, I want to specify a name, working directory, and permission mode when spawning an agent, so that each agent is configured for its task.
5. As a developer, I want the working directory to default to where I started the server, so that spawning is fast for the common case.
6. As a developer, I want to click an agent's desk to open their conversation view, so that I can see what they're doing and interact with them.
7. As a developer, I want to send messages to an agent via an input box in the conversation view, so that I can give them tasks and follow-up instructions.
8. As a developer, I want to see the agent's output as structured cards (markdown text, collapsible tool calls, thinking blocks, errors), so that I can understand what the agent is doing without parsing raw text.
9. As a developer, I want to press Escape to return from the conversation view to the office view, so that navigation is fast.
10. As a developer, I want agents to visually reflect their current state (idle, working, waiting, error) through animations and status indicators, so that I know who needs my attention.
11. As a developer, I want a notification sound when an agent needs attention and I'm not looking at the app, so that I don't miss requests.
12. As a developer, I want a visual badge on the agent's desk when they need attention and I'm looking at a different agent, so that I know to switch.
13. As a developer, I want to right-click an agent to access a context menu with operations (new conversation, resume, kill), so that agent management is discoverable.
14. As a developer, I want to start a "new conversation" for an agent, clearing their context while keeping the same name/desk/directory, so that I can give them a fresh task without re-spawning.
15. As a developer, I want to "resume" a past conversation for an agent, so that I can pick up where a previous task left off.
16. As a developer, I want to "kill" an agent, removing them from the office and freeing their desk, so that I can make room for new agents.
17. As a developer, I want my agents to persist across server restarts, so that I don't have to re-create my team every time I restart the app.
18. As a developer, I want agents to auto-resume their last conversation on restart, so that work in progress isn't lost.
19. As a developer, I want a global office that is the same regardless of where I start the server, so that my team is always my team.
20. As a developer, I want each agent to use my Claude subscription (not API credits), so that running agents doesn't incur per-token costs.
21. As a developer, I want agents to have access to my global Claude Code skills and MCP servers, so that they have the same capabilities as my normal Claude Code sessions.
22. As a developer, I want to choose a permission mode per agent (default, accept edits, bypass permissions), so that I can control how much autonomy each agent has.
23. As a developer, I want to see a short preview of the agent's latest output on their desk monitor in the office view, so that I get a sense of progress without opening the full conversation.
24. As a developer, I want the app to start with a single command (`bun dev`), so that setup is minimal.
25. As a developer, I want agents to use Opus 4.6 by default, so that I get the most capable model without configuration.
26. As a developer, I want the agent's outfit to be deterministically generated from their name, so that the same name always produces the same character.

## Implementation Decisions

### Architecture
- **Single Bun process.** No separate server/client processes. One process serves the UI as static files, manages agents in-process via the SDK, and communicates with the browser via WebSocket.
- **No database.** State is in-memory. Agent configs persist to `~/.isomux/agents.json`. Logs are appended to `~/.isomux/logs/` as JSON lines files (one per agent session).
- **WebSocket-only communication.** First message on connect is a `full_state` snapshot. All subsequent communication is incremental updates and commands. No REST API.

### Agent SDK Integration
- **Claude Agent SDK V2** (`unstable_v2_createSession` / `unstable_v2_resumeSession`). Chosen despite `@alpha` status because the API is cleaner for multi-turn (`send()`/`stream()` on a persistent session object).
- **Subscription auth confirmed working.** SDK spawns the CLI as a subprocess; the CLI uses whatever auth is configured. Tested with no `ANTHROPIC_API_KEY` set — subscription rate limits applied.
- **Default model: Opus 4.6.** No per-agent model selection in v1.
- **Permission modes map directly to SDK options:** `default`, `acceptEdits`, `bypassPermissions`.
- **Global Claude skills and MCP servers** are inherited automatically since the SDK spawns the user's CLI.

### Data Model
- **Agent (the human):** Persistent. Fields: name, desk (0-7), outfit (from name hash), cwd, permissionMode, lastSessionId. Stored in `agents.json`.
- **Conversation (the task):** Ephemeral, in-memory. Fields: sessionId, SDKSession object, state (derived from stream events), logEntries (full log in memory). Backed by SDK session files on disk for resume.
- **On restart:** Agents restored from `agents.json`. Last conversation auto-resumed via `resumeSession()`. On resume failure, agent comes back idle.

### Module Breakdown
1. **AgentManager** — Deep module. Encapsulates SDK session lifecycle, stream event parsing, state derivation, log writing. Exposes: spawn, kill, sendMessage, newConversation, resumeConversation, event emitter. If the SDK API changes, only this module changes.
2. **Persistence** — Thin. Reads/writes `agents.json`, appends to log files.
3. **WebSocketHub** — Thin. Relays AgentManager events to browsers, routes browser commands to AgentManager.
4. **Server** — Entry point. Bun HTTP + WebSocket, serves static UI, initializes everything, auto-resumes agents on startup.
5. **UI: OfficeView** — React/SVG. Isometric 8-desk grid, state-driven animations, click/right-click interactions.
6. **UI: LogView** — React. Structured message cards + input box.
7. **UI: WebSocket client + store** — Client-side state management, WebSocket connection.

### Frontend
- **React/SVG.** No Pixi.js. The reference prototype's SVG approach handles 8 desks with animations without WebGL overhead.
- **Bun's built-in bundler.** No Vite. Manual browser refresh during development.
- **`reference_ui.jsx` is a visual spec**, not code to refactor. The real UI is rebuilt from scratch with WebSocket-driven state, pulling SVG/animation details from the prototype.

### Notification Strategy
- **Visual:** Status badge/pulse on the agent's desk in the office view. Always visible.
- **Audio:** Notification sound plays when the browser tab is unfocused (`document.hidden`).

## Testing Decisions

### What makes a good test
Tests should verify external behavior through the module's public interface, not implementation details. Mock the SDK to avoid real API calls. Assert on state transitions and emitted events, not internal data structures.

### Modules to test
- **AgentManager** — the only module with enough internal complexity to warrant unit tests. Test cases:
  - Spawn creates agent, emits event, persists config
  - Send message transitions state through the expected lifecycle (idle → working → idle)
  - New conversation resets session while preserving agent config
  - Kill cleans up session and emits removal event
  - Resume reconnects to an existing session ID
  - Stream event parsing correctly derives state (thinking, tool executing, idle, error)
  - Error handling: SDK crash → error state, resume failure → idle state

### Modules NOT tested (glue code)
- Persistence (trivial JSON read/write)
- WebSocketHub (thin relay)
- Server (wiring)
- UI components (validated by manual use)

## Out of Scope

- **Cost tracking/badges** — irrelevant with subscription billing
- **Per-agent model selection** — Opus 4.6 only for v1
- **Outfit customization** — deterministic from name only; customization is a future feature
- **Auto mode** — not available on individual plans or in SDK yet
- **Agent-to-agent communication**
- **Remote agents** — all agents run locally in-process
- **CLI-based agent spawning or `agents.toml` config file**
- **Interactive permission cards** — SDK built-in modes only, no custom approval UI
- **Audio beyond notification sounds**
- **Deployment/production** — this is a local-only dev tool

## Further Notes

- **SDK stability risk:** The V2 API is `@alpha`. If it breaks in a future SDK update, the fix is isolated to AgentManager. The V1 `query()` with `resume` is a known fallback.
- **Rate limits:** With 8 agents on Opus 4.6 and a Max subscription, heavy concurrent use may hit the 5-hour rate window. The SDK emits `rate_limit_event` messages — we surface these as a "waiting" state on the agent's desk. No special handling needed.
- **Session files:** The SDK persists sessions to `~/.claude/projects/<cwd>/<session-id>.jsonl`. The "resume" feature relies on these files existing. Our own logs in `~/.isomux/logs/` are separate and serve a bookkeeping purpose only.
- **Reference prototype:** `reference_ui.jsx` contains all SVG paths, colors, animations, and layout logic for the office. It is the visual source of truth for the isometric art style.
