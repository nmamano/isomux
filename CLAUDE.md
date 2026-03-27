# Isomux

An isometric 2D office UI for managing multiple concurrent Claude Code agents. Each agent sits at a desk, has a unique outfit, and visually reflects its current state (working, waiting, idle). Built on Bun, runs locally.

## Running

```bash
bun install
bun run dev          # builds UI + starts server
```

Then open http://localhost:4000. To use a different port: `PORT=5000 bun run dev`

When developing, rebuild the UI after changes: `bun run build:ui`, then refresh the browser.

## Architecture

Single Bun process. Serves static UI, manages agents in-process via Agent SDK, communicates with the browser via WebSocket.

```
Browser ↔ WebSocket ↔ Bun Server (serves UI + manages agents)
```

- **No separate client process.** Agents run in-process via `@anthropic-ai/claude-agent-sdk` V2 sessions.
- **No database.** State is in-memory. Agent configs persist to `~/.isomux/agents.json`. Logs go to `~/.isomux/logs/`.
- **No Vite.** Bun's built-in bundler for the frontend. Manual browser refresh during dev.
- **React/SVG.** No Pixi.js. SVG characters and isometric layout.

## Tech Stack

- **Runtime**: Bun
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` V2 (TypeScript), subscription auth
- **UI rendering**: React + SVG (isometric office, characters, animations)
- **State management**: React context + useReducer
- **WebSocket**: Bun native
- **Bundler**: Bun built-in

## Key Decisions (Do Not Revisit)

- Single Bun process — no separate server/client processes.
- Agent SDK V2 (`unstable_v2_createSession`) with subscription auth. High risk tolerance on alpha API.
- React/SVG, not Pixi.js. The reference UI's SVG approach is sufficient.
- Bun bundler, not Vite. Manual refresh is fine.
- No SQLite. In-memory state, flat file logs, agents.json for persistence.
- 8 desks max (fixed grid).
- No terminal. Agents are headless SDK sessions. Log view is structured cards.
- Default model: Opus 4.6. No per-agent model selection in v1.
- Permission modes: per-agent, SDK built-in (`default`, `acceptEdits`, `bypassPermissions`).
- Global office (`~/.isomux/`). Same team regardless of where server starts.
- Agent = persistent human (name, desk, outfit, cwd). Conversation = ephemeral task (session).
- Agents persist across restarts. Auto-resume last conversation on startup.
- Notification: visual badge on desk + sound when tab unfocused.
- No cost badges (subscription-based).
- No agent-to-agent communication.
- `reference_ui.jsx` is a visual spec, not code to refactor.

## Project Structure

```
isomux/
├── CLAUDE.md
├── DECISIONS.md          # full design rationale
├── DESIGN.md             # original protocol spec (partially superseded by DECISIONS.md)
├── SDK_INVESTIGATION.md  # Agent SDK research and test results
├── PRD.md                # product requirements document
├── plans/isomux.md       # phased implementation plan
├── reference_ui.jsx      # visual spec (working prototype)
├── package.json
├── tsconfig.json
├── server/
│   ├── index.ts          # Bun HTTP + WebSocket server, agent registry
│   └── outfit.ts         # deterministic outfit generation from name hash
├── shared/
│   └── types.ts          # AgentInfo, LogEntry, ServerMessage, ClientCommand
└── ui/
    ├── index.html
    ├── index.tsx          # React entry point
    ├── App.tsx            # main app (routes between office and log view)
    ├── store.tsx          # React context + useReducer state management
    ├── ws.ts              # WebSocket client
    ├── styles.ts          # CSS animations and global styles
    ├── office/
    │   ├── grid.ts        # isometric grid math
    │   ├── OfficeView.tsx # main office scene
    │   ├── DeskUnit.tsx   # occupied desk with character
    │   ├── EmptySlot.tsx  # empty desk slot
    │   ├── DeskSprite.tsx # desk furniture SVG
    │   ├── Character.tsx  # character SVG with state-driven poses
    │   ├── StatusLight.tsx# status indicator dot
    │   ├── Floor.tsx      # floor tiles + walls
    │   └── RoomProps.tsx  # decorative objects
    ├── log-view/
    │   └── LogView.tsx    # conversation view with input box
    └── components/
        └── SpawnDialog.tsx# spawn new agent dialog
```

## Implementation Status

All 5 phases complete:
- **Phase 1**: Static office + WebSocket skeleton
- **Phase 2**: Real SDK integration (V2 sessions with launcher script for cwd)
- **Phase 3**: Structured log view (markdown, collapsible tool calls)
- **Phase 4**: Agent lifecycle (kill, new conversation, persistence across restarts)
- **Phase 5**: Resume, notifications, monitor preview

See `plans/isomux.md` for full phase details. See `TODO.md` for backlog.

## Dev Workflow

**Don't ask the user to run commands — just do it.** Run the dev server in a background process and tell the user the URL.

### Build and test cycle
1. Make changes to server (`server/`) or UI (`ui/`)
2. Kill old server: `pkill -f "bun run server/index.ts"`
3. Rebuild and restart: `bun run build:ui && bun run server/index.ts` (run in background)
4. Tell user to refresh http://localhost:4000
5. User tests and reports back
6. Read agent conversation logs at `~/.isomux/logs/<agentId>/<sessionId>.jsonl` to debug — don't ask the user to copy-paste conversations

### Key paths
- Agent configs persist at `~/.isomux/agents.json`
- Agent logs at `~/.isomux/logs/`
- Launcher scripts (for cwd workaround) at `~/.isomux/launchers/`
- UI builds to `ui/dist/` (gitignored)
- Default port: 4000 (override with `PORT` env var)

### Minor issues go in TODO.md
Don't fix minor UI issues inline during feature work. Add them to `TODO.md` and move on. The user will prioritize them later.

### Commit after each milestone
Commit and push after completing each phase, feature, or batch of fixes. Keep commits focused.
