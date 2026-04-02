# Demo Mode Plan

Public interactive demo at `isomux.com/demo`. Users can explore the full office UI — create agents, customize outfits, manage rooms — but cannot make LLM calls. State is ephemeral (in-memory, resets on refresh).

## Architecture

### Refactor: extract office state from agent-manager

`server/agent-manager.ts` (1500 lines) currently mixes three concerns:

1. **Pure office state** — create/edit/move agents, rooms, desks, topics, todos (~300 lines)
2. **Claude SDK lifecycle** — spawn, send, stream, abort, resume sessions (~800 lines)
3. **System I/O** — file persistence, terminal PTY, skill discovery (~400 lines)

Extract #1 into `shared/office-state.ts`:

- Pure functions/class managing agents, rooms, desks, outfits, topics, todos, office prompt
- No imports from `fs`, `Bun`, or the SDK
- No persistence dependency — the module manages state in memory only
- Callers are responsible for persisting state (production: `persistence.ts` writes to disk after mutations; demo: no-op)

`server/agent-manager.ts` imports `shared/office-state.ts` and adds SDK lifecycle + persistence on top. Production behavior is unchanged.

This refactor improves the production codebase independently of the demo: testable office logic, clearer separation of concerns, easier to navigate.

### Extraction boundary: what "spawn" and "kill" mean in office-state

`spawn` in production does many things: create `AgentInfo`, assign a desk, create launcher scripts, discover skills, create an SDK session, start streaming. In `shared/office-state.ts`, `spawn` means only:

- Validate desk availability
- Generate outfit via `generateOutfit()`
- Create an `AgentInfo` record (name, desk, cwd, outfit, state, room)
- Add it to the rooms data structure
- Return the `AgentInfo` and an `agent_added` event

Everything else (SDK session, launcher, skills, streaming) is layered on by `server/agent-manager.ts`. Similarly, `kill` in office-state just removes the agent from the data structure — the server handles session cleanup.

Capacity constraints (8 desks per room) are enforced in office-state, not the server. This ensures the demo and production have identical limits.

### Reducing coupling: feature flags context

To avoid scattering `DEMO_MODE` checks throughout production UI components, introduce a feature flags context:

```tsx
// shared/features.ts
export type Features = {
  sessions: boolean;      // session picker, new conversation, resume
  terminal: boolean;      // terminal open/panel
  llmConnected: boolean;  // false in demo — send_message produces fake response
};
```

Production entry sets all to `true`. Demo entry disables `sessions` and `terminal`, and sets `llmConnected` to `false`. Components check `features.sessions` — they don't know about "demo mode," just feature availability. This keeps demo knowledge entirely out of production components and is extensible if future features need gating.

### Reducing coupling: domain events, not wire messages

`shared/office-state.ts` returns **domain events**, not `ServerMessage` objects. This keeps the module focused on state transitions without encoding transport concerns.

```ts
type OfficeEvent =
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "desks_swapped"; room: number; desk1: number; desk2: number }
  | { type: "office_prompt_set"; value: string }
  // etc.
```

Each caller translates events → messages:
- **Server** translates events to `ServerMessage` and enriches them (e.g. attaches real `slash_commands` from SDK discovery after `agent_added`)
- **Demo shim** translates events to the same `ServerMessage` shapes with demo-appropriate values (e.g. empty `slash_commands`)

This separation means:
- Office-state is purely about state + business rules — no transport knowledge
- `slash_commands` stays outside office-state (it's SDK-derived, never state-derived)
- Each consumer can enrich events independently without polluting shared code

The initial state burst (`full_state` + `office_prompt` + `todos` on connect) is also the caller's responsibility. Office-state exposes `getState()` and each caller constructs the appropriate messages.

### Demo: client-side WebSocket shim

The React app runs identically in demo mode. The only seam is at the WebSocket transport layer:

- `ui/demo-entry.tsx` is a separate build entry point (how the UI knows it's in demo mode)
- Instead of opening a real WebSocket, it routes commands to a local handler
- The local handler uses `shared/office-state.ts` with state held in a plain object (no persistence, lost on refresh)
- It translates office-state domain events into `ServerMessage` responses
- Everything above the transport — store, reducer, components — is the same code path

### Initial state messages

On initialization, the demo shim calls `officeState.getState()` and constructs the message burst the UI expects:

- `full_state` — agents (empty array), roomCount (1), recentCwds (empty array)
- `office_prompt` — empty string
- `todos` — empty array

On agent spawn, the demo shim translates the `agent_added` event into `ServerMessage`s and appends `slash_commands` with empty arrays (no SDK to discover commands from). The store handles this gracefully.

### recentCwds

Users can type any CWD when spawning agents. Whatever they enter is accepted as-is (no filesystem validation — there's no filesystem). Each entered CWD is added to the in-memory recentCwds list and appears in the autocomplete for subsequent spawns.

## Build & deploy

Single `build:ui` command produces both outputs to guarantee sync:

- `ui/dist/` — main app (existing)
- `site/demo/` — demo bundle

```json
{
  "build:ui": "bun build ui/index.tsx --outdir ui/dist --production && cp ui/index.html ui/dist/index.html && cp node_modules/@xterm/xterm/css/xterm.css ui/dist/xterm.css && bun build ui/demo-entry.tsx --outdir site/demo --production && cp ui/index.html site/demo/index.html && cp node_modules/@xterm/xterm/css/xterm.css site/demo/xterm.css"
}
```

Deployed to `isomux.com/demo` via Vercel as a subdirectory of `site/`. No server process needed — purely static files.

Note: the build command is getting long. Consider extracting to `scripts/build.sh` during implementation so both `package.json` and CI call the same script.

## Command behavior in demo mode

### Works normally (office state)

These commands are handled by `shared/office-state.ts` and work identically to production:

- `spawn` — create agent at desk (office-state only: AgentInfo + desk assignment)
- `kill` — remove agent from office
- `edit_agent` — change name, cwd, outfit, custom instructions
- `swap_desks` — swap agent positions
- `create_room` — add a room
- `close_room` — remove empty room
- `move_agent` — move agent between rooms
- `set_topic` / `reset_topic` — agent topic
- `set_office_prompt` — office-wide prompt (stored in memory)
- `add_todo` / `delete_todo` — shared todo list (stored in memory)

### Fake response

- `send_message` — a fake agent "reply" appears as a normal text log entry: *"This is a demo. Your message was not actually sent to Claude. To use Isomux for real, follow the setup instructions at isomux.com."*
- This logic lives in `demo-server.ts`, not `office-state.ts` — office-state manages state, not message content.
- Slash commands (`/foo`) get the same fake response — no need to hide the autocomplete UI.

### Silent no-op

- `abort` — nothing to abort
- `terminal_open` / `terminal_input` / `terminal_resize` / `terminal_close` — terminal UI is hidden via `features.terminal`, so these commands should never be sent. No-op if they are.

### Hidden UI (via feature flags)

Components check the feature flags context — when `features.sessions` is false, session-related UI is not rendered:

- `new_conversation`
- `resume`
- `list_sessions`

When `features.terminal` is false, terminal UI is not rendered (rather than showing an error):

- `terminal_open` — button hidden

## UX details

- **Initial state:** Empty office. Users discover the product by creating agents themselves.
- **Username:** Skipped. Hardcoded to "demo-user".
- **Banner:** Persistent top banner: "You're exploring a demo office. To connect real Claude agents → isomux.com" linking to `isomux.com`.
- **URL:** Flat `/demo`, no sub-routes. State is ephemeral so deep links have no value.

## Files to create/modify

### New files

- `shared/office-state.ts` — pure office state management (agents, rooms, desks, outfits, topics, todos, office prompt). No I/O. Returns domain events (`OfficeEvent`), not wire messages.
- `shared/features.ts` — feature flags type + default configs for production and demo.
- `ui/demo-entry.tsx` — demo app entry point. Wires demo shim, hardcodes username, provides demo feature flags.
- `ui/demo-server.ts` — local command handler (WebSocket shim). Holds state in plain object, translates `OfficeEvent`s to `ServerMessage`s, handles fake responses.

### Modified files

- `server/agent-manager.ts` — import and delegate to `shared/office-state.ts`
- `server/index.ts` — translate office-state events to `ServerMessage`s, construct initial state burst on WebSocket connect
- `ui/ws.ts` — minor changes to support shim injection
- UI components (session picker, terminal button, etc.) — check feature flags context instead of hardcoded visibility
- `package.json` — update `build:ui` script to produce both outputs
