# Design Document: Claude Office

## 1. Concept

A local Bun app presenting an isometric 2D office with 8 desks. Each desk hosts one concurrent top-level agent. Agents have names, assigned desks, and unique outfits (deterministic from name hash). Their visual state reflects what they're doing: working, waiting for user input, idle, error, etc.

The user manages agents by interacting with the office: clicking an agent's monitor expands into a structured log/conversation view; clicking an empty desk spawns a new agent; right-clicking gives context actions. Under the hood, each agent is a headless Claude Code session via the Agent SDK.

---

## 2. Architecture: Client/Server Decoupling

The system is split into three components connected by WebSocket:

### Office Server (Bun)
- Serves the browser UI (static files)
- Maintains the agent registry (SQLite)
- Routes messages between clients and browsers
- Persists all log entries to SQLite
- **Knows nothing about agent runtimes.** It only understands the protocol.

### Client(s)
- Thin wrappers around agent runtimes
- Speak a runtime-agnostic WebSocket protocol
- v1 ships with one client: Claude Code (via Agent SDK)
- Future clients could wrap Codex, Aider, or anything else
- Can run locally (same machine as server) or remotely (any machine with WebSocket access)

### Office UI (Browser)
- Pixi.js isometric office renderer (canvas)
- React components for log view, dialogs, menus (DOM overlay on top of canvas)
- Connects to server via WebSocket at `/ws/browser`
- Receives state snapshots and real-time events
- Sends user actions (messages, permission responses, spawn/kill commands)

### Why This Split
- Remote agents aren't special — they're just clients connecting from another machine
- The protocol is agent-runtime-agnostic, so supporting non-Claude agents later is just a new client implementation
- Testing the office UI can use mock clients that emit synthetic events
- The server has zero dependencies on the Agent SDK

---

## 3. The Client Protocol (Full Specification)

This is the foundational contract. All communication between clients and the server, and between the server and browsers, flows through these types.

### 3.1 Connection Lifecycle

```
Client connects to ws://server:7777/ws/client
  → Client sends ClientHandshake
  → Server registers client and its agents
  → Server broadcasts agent_joined events to browsers

Browser connects to ws://server:7777/ws/browser
  → Server sends OfficeSnapshot with all current agent state
```

### 3.2 Client → Server Events

```typescript
interface ClientHandshake {
  type: 'handshake';
  clientId: string;              // unique, persistent across reconnects
  clientType: 'claude-code';     // future: 'codex', 'aider', etc.
  agents: AgentManifest[];       // agents this client currently manages
}

interface AgentManifest {
  agentId: string;
  name: string;
  cwd: string;
  sessionId?: string;            // if resuming an existing SDK session
  state: AgentState;
}

type ClientEvent =
  | { type: 'state_change'; agentId: string; state: AgentState; timestamp: number }
  | { type: 'log_entry'; agentId: string; entry: LogEntry }
  | { type: 'permission_request'; agentId: string; requestId: string;
      tool: string; input: Record<string, unknown> }
  | { type: 'ask_question'; agentId: string; requestId: string;
      questions: AskUserQuestion[] }
  | { type: 'cost_update'; agentId: string; costUsd: number; tokensUsed: TokenUsage }
  | { type: 'activity'; agentId: string; activity: string; detail?: string }
  | { type: 'error'; agentId: string; error: string; recoverable: boolean }
  | { type: 'agent_stopped'; agentId: string; reason: 'completed' | 'killed' | 'error' }
```

### 3.3 Server → Client Commands

```typescript
type ServerCommand =
  | { type: 'send_message'; agentId: string; message: string }
  | { type: 'permission_response'; requestId: string;
      decision: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }
  | { type: 'question_response'; requestId: string; answers: Record<string, string> }
  | { type: 'spawn'; config: AgentSpawnConfig }
  | { type: 'kill'; agentId: string }
  | { type: 'ping' }
```

### 3.4 Shared Types

```typescript
type AgentState =
  | 'starting'            // session being created
  | 'idle'                // waiting for user to send next message
  | 'thinking'            // extended thinking active
  | 'generating'          // streaming text response
  | 'tool_executing'      // running a tool (bash, read, edit, etc.)
  | 'waiting_permission'  // canUseTool callback is blocking
  | 'waiting_answer'      // AskUserQuestion is blocking
  | 'error'               // something went wrong
  | 'stopped'             // session ended

interface LogEntry {
  id: string;
  timestamp: number;
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' |
        'error' | 'system' | 'user_message';
  content: string;
  metadata?: {
    toolName?: string;
    filePath?: string;
    exitCode?: number;
    duration?: number;
  };
}

interface AgentSpawnConfig {
  agentId: string;
  name: string;
  cwd: string;
  model?: string;
  allowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  prompt?: string;               // initial task to send immediately
  resumeSessionId?: string;      // resume existing conversation
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface AskUserQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

interface AgentOutfit {
  hatType: string;
  shirtColor: string;
  accessory?: string;
}
```

---

## 4. Agent SDK Integration (Research Findings)

### 4.1 Multi-Turn Sessions — Confirmed Working

The SDK fully supports multi-turn conversations. Two approaches:

**V2 Session API (preferred, but unstable preview):**
```typescript
import { unstable_v2_createSession, unstable_v2_resumeSession }
  from '@anthropic-ai/claude-agent-sdk';

const session = unstable_v2_createSession({
  model: 'claude-sonnet-4-6',
  cwd: '/path/to/project',
  // ...options
});

await session.send("Refactor the auth middleware");
for await (const msg of session.stream()) { /* handle events */ }

// Turn 2 — full context preserved automatically
await session.send("Now add OAuth2 support");
for await (const msg of session.stream()) { /* handle events */ }

// Resume after restart
const resumed = unstable_v2_resumeSession(sessionId, { model: '...' });
```

Each agent desk maps to one SDKSession. `send()` is the input box, `stream()` drives the log view and state animations.

**V1 Fallback (stable):**
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// First query creates a session
for await (const msg of query({ prompt: "Analyze auth", options: { ... } })) { ... }

// Second query: continue: true resumes the most recent session in the cwd
for await (const msg of query({ prompt: "Now refactor it", options: { continue: true, ... } })) { ... }
```

**Session persistence**: Sessions are stored at `~/.claude/projects/<encoded-cwd>/*.jsonl`. They survive server restarts and can be resumed by session ID.

### 4.2 Permission Handling — canUseTool Callback

The `canUseTool` callback is a first-class blocking control channel. It fires when Claude wants to use a tool that isn't auto-approved, and **pauses execution until the callback returns**.

```typescript
canUseTool: async (toolName, input, options) => {
  // Forward to office UI via WebSocket, block until user responds
  const decision = await forwardToUIAndWait(agentId, toolName, input);

  if (decision === 'allow') {
    return { behavior: 'allow', updatedInput: input };
  } else {
    return { behavior: 'deny', message: 'User rejected this action' };
  }
}
```

**Processing order**: PreToolUse Hook → Deny Rules → Allow Rules → Ask Rules → Permission Mode Check → canUseTool Callback → PostToolUse Hook

This means we can pre-approve safe operations (reads, greps) via `allowedTools` and only surface interesting decisions to the user.

**AskUserQuestion**: When Claude has clarifying questions, it calls the `AskUserQuestion` tool, which also triggers `canUseTool`. The input contains structured questions with labeled options — perfect for rendering as clickable UI elements. There is an official SDK demo (branding assistant) that round-trips AskUserQuestion from the SDK to a browser over WebSocket.

### 4.3 State Derivation from Stream Events

With `includePartialMessages: true`, the SDK streams typed events:

| Event | Derived State |
|---|---|
| `content_block_delta` with `thinking_delta` | `thinking` |
| `content_block_delta` with `text_delta` | `generating` |
| `content_block_start` with `tool_use` type | `tool_executing` |
| `canUseTool` callback fires | `waiting_permission` or `waiting_answer` |
| `result` message | done → `idle` |

No PTY scraping, no ANSI parsing, no regex heuristics. All states are derived from typed events.

### 4.4 Hooks (Supplementary)

Hooks are available for observability but are NOT the primary state source (the stream is). Useful hooks:
- `TeammateIdle` — fires when agent is idle (TypeScript SDK only)
- `TaskCompleted` — fires when a task finishes
- `Notification` with `permission_prompt` — fires when waiting for permission
- `PreToolUse` / `PostToolUse` — tool lifecycle

HTTP hooks can POST to an endpoint, useful if we want additional observability beyond the stream events. Not required for v1 core functionality since the stream gives us everything we need.

---

## 5. The Claude Code Client Implementation

The client is a thin protocol adapter: SDK events in, ClientEvents out; ServerCommands in, SDK calls out. Core pattern:

1. On `spawn` command: create SDK session, wire up `canUseTool`, start streaming
2. On stream events: derive state + log entries, emit via WebSocket
3. On `send_message` command: call `session.send()`, consume new stream
4. On permission/question requests: block `canUseTool` with a Promise, resolve when server sends response
5. On `kill` command: call `session.close()`

**The permission bridge** is the critical pattern: `canUseTool` returns a Promise that only resolves when the server sends back a `permission_response` or `question_response` command. This turns an async WebSocket round-trip into a synchronous-looking gate from the SDK's perspective.

---

## 6. Server Implementation Notes

### SQLite Schema

```sql
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  desk INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  outfit TEXT NOT NULL,           -- JSON (AgentOutfit)
  client_id TEXT,
  session_id TEXT,
  task_label TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE log_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,                  -- JSON, nullable
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);
```

### WebSocket Routing

Two WebSocket pools:
- `/ws/client` — agent clients (Claude Code wrappers)
- `/ws/browser` — office UI instances

Events from clients are: (a) applied to in-memory state, (b) persisted to SQLite where relevant, (c) broadcast to all browsers.

Actions from browsers are routed to the correct client based on which client owns the target agent.

### Outfit Generation

Deterministic from agent name via hash:
- Hash the name string
- Use different bit ranges to index into arrays of hats, shirt colors, and accessories
- Same name always produces same outfit

---

## 7. Office UI

### View Modes

Two views, mutually exclusive:
1. **Office View** — isometric Pixi.js canvas showing all 8 desks
2. **Log View** — React component showing one agent's conversation history + input box

Transition: click agent monitor → log view. Press Esc / back → office view.

### Office View Details

Isometric grid: 2 columns × 4 rows, offset for perspective. Each desk is a composite sprite:

| Layer | Content |
|---|---|
| Desk surface | Monitor, keyboard, personal items |
| Monitor screen | Last 2-3 lines of output as mini text |
| Status badge | Folder path, current tool being used |
| Agent character | Layered sprite with outfit + state animation |
| Cost badge | Running dollar amount |

### Character Sprite Layers (bottom to top)

1. Shadow
2. Chair
3. Body (pose varies by state)
4. Shirt (tinted by outfit.shirtColor)
5. Head (expression varies by state)
6. Hat (outfit.hatType)
7. Accessory (outfit.accessory)
8. State overlay (Zzz, ?, !, etc.)

### Character Animation States

| State | Body Pose | Overlay | Monitor |
|---|---|---|---|
| `starting` | Walking to desk | None | Off |
| `idle` | Leaning back, relaxed | None | Dim, cursor blink |
| `thinking` | Chin on hand | `...` thought bubble | Subtle glow |
| `generating` | Typing rapidly | None | Text scrolling |
| `tool_executing` | Typing, leaning in | Tool icon | Bright, active |
| `waiting_permission` | One hand raised | `?` speech bubble | Shows tool name |
| `waiting_answer` | Both hands up, shrug | `??` speech bubble | Shows question |
| `error` | Arms up, startled | `!` red | Red screen |
| `stopped` | Head on desk | `Zzz` | Off |

For v1 pixel art: each pose is a separate sprite frame (not skeletal). ~10 body frames total, swapped on state change. Overlays are separate animated sprites anchored to head position.

### Log View Details

Structured conversation view (not a terminal). Shows:
- User messages (right-aligned or distinguished)
- Agent text output (streamed in real-time)
- Thinking blocks (dimmed/collapsible)
- Tool calls (collapsible cards showing tool name, input, output)
- Permission requests (inline Allow/Deny buttons)
- AskUserQuestion (inline option buttons)
- Errors (red cards)

Input box at bottom for sending messages to the agent.

### Quick Permission Popover

When an agent is in `waiting_permission` state and the user is in office view:
- Click/hover the agent → small popover showing the permission request
- Allow/Deny buttons right there
- Avoids having to expand into full log view for simple approvals

### Interactions

| Action | Where | What Happens |
|---|---|---|
| Click agent's monitor | Office view | Expand to log view for that agent |
| Press Esc / click back | Log view | Return to office view |
| Click empty desk | Office view | Open spawn dialog |
| Right-click agent | Office view | Context menu: rename, kill, restart, change task label |
| Type + Enter | Log view input box | Send message to agent |
| Click Allow/Deny | Log view or quick popover | Respond to permission request |
| Click option button | Log view | Respond to AskUserQuestion |

---

## 8. Remote Agents

A remote client connects via WebSocket exactly like a local one. The server doesn't know the difference.

**Setup:**
1. Run the Claude Code client on the remote machine
2. Point it at the office server's WebSocket endpoint: `ws://server-ip:7777/ws/client`
3. The client sends its handshake with its agents
4. Those agents appear in the office alongside local ones

**For firewalled environments:** SSH tunnel (`ssh -L 7777:localhost:7777 remote`) or reverse tunnel from the remote machine.

The protocol handles disconnection: if a client's WebSocket drops, the server marks all its agents as `error` state and broadcasts to browsers. When the client reconnects and re-handshakes, agents are restored.

---

## 9. Configuration

### agents.toml (Optional)

```toml
[[agent]]
name = "API Backend"
cwd = "~/projects/api"
desk = 0

[[agent]]
name = "Frontend"
cwd = "~/projects/web"
desk = 1

[[agent]]
name = "Infrastructure"
cwd = "~/projects/infra"
host = "devbox.internal"   # remote — client must be running on that host
desk = 4
```

On startup, the local client reads this file and spawns agents accordingly. Remote agents in the config are informational only — they require a client running on the remote host.

### Spawn Dialog Fields

- Name (text input)
- Working folder (text input with autocomplete / browse)
- Initial prompt (textarea, optional)
- Model (dropdown, optional — defaults to configured default)
- Permission mode (dropdown: default / acceptEdits / bypassPermissions)

---

## 10. Error States and Recovery

| Error | Visual | Recovery |
|---|---|---|
| Agent SDK process crashes | Character: arms up, startled. Red `!` overlay. Red dot. | Right-click → Restart. New session in same cwd. |
| Client WebSocket disconnects | Character: frozen in last pose, grayed out. `⚡` overlay. | Auto-recovers when client reconnects and re-handshakes. |
| Agent hits API rate limit | Character: waiting pose. `⏳` overlay. | SDK handles retry internally. State returns to working when retry succeeds. |
| Agent runs out of context (compaction) | No visual change — compaction is transparent. | SDK compacts automatically. `PreCompact` hook fires if we want to log it. |
| Tool execution fails | Brief flash of error in log view. Agent continues. | No user intervention needed — Claude handles tool errors in its loop. |
| Unrecoverable SDK error | Character: error state. Red screen on monitor. | Right-click → Kill, then spawn new agent. Session may be resumable. |

General principle: if the SDK can recover, don't bother the user. Only surface errors that require user intervention.

---

## 11. Open Items (Not Yet Decided)

- **V2 API stability**: The V2 session API is marked `unstable_`. If it breaks or is missing features, fall back to V1 `continue: true`. Build the client abstraction so swapping is internal.
- **Log entry streaming granularity**: `text_delta` events are very frequent (every few tokens). Decide whether to batch them into coarser log entries for SQLite writes (e.g., one entry per complete text block vs. one per delta). Stream raw deltas to the browser but persist coarser entries.
- **Session resumption UX**: When the server starts and finds existing sessions in `~/.claude/projects/`, how should it present "resume" vs "start fresh"? Options: auto-resume all, prompt user, or add a resume button per desk.
- **Sprite art pipeline**: Art assets are being handled separately. The Pixi.js renderer should be built to accept a sprite sheet + animation config, not hardcode frame positions.
