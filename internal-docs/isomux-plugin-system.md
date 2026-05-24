# Isomux Plugin System + mem0 Reference Plugin

> Status: implemented (v0). Hybrid `enabledPlugins` schema (string for bundled, `{id, path}` for external) chosen during review — see the "Discovery and loading" section.

Two pieces, implemented together in one session:

1. **A first-party, in-process plugin system for isomux.** TypeScript modules register hooks against the agent turn lifecycle. Provider-agnostic by construction (hooks fire from isomux core, independent of Claude vs Codex backends). Lands in isomux's main repo.
2. **A reference plugin for mem0** that proves the contract end-to-end. Throwaway code; lives outside the isomux repo at `~/nil/isomux-mem0/`, never committed to isomux's git history.

Distinct from `plugin-management-design.md`, which covers UI for managing Claude Code's plugin ecosystem (an upstream concern).

## Motivation

Several plausible integrations (memory layers, observability, redaction, audit) need to sit in the agent turn loop on both providers. The Claude Code plugin system covers Claude only; Codex has no equivalent hook surface. Without an isomux-level extension point, every such integration has to be built provider-by-provider or hardcoded into core.

The triggering use case is mem0 (a memory layer). The plugin system is the long-lived investment; the mem0 plugin itself is throwaway, but it's the concrete v0 demonstration and tests the contract under a real consumer.

## Goals (v0)

- One first-party extension point for agent-turn middleware that works across all providers.
- Two hooks: `beforeTurn` and `afterTurn`. Enough for a memory plugin; intentionally minimal.
- In-process TypeScript plugins loaded by the Bun runtime. No IPC, no separate runtimes.
- Office-wide enable/disable via `office-config.json`.
- Trust model: full-trust local code. No sandboxing claims.
- A working mem0 plugin (mem0 cloud mode) that prepends retrieved memories on `beforeTurn` and stores new facts on `afterTurn`.

## Non-goals (v0)

For the plugin system:
- Out-of-process plugins (any language). Reconsidered when there's a real Python-only dep we need to integrate.
- Additional hooks (`onAgentCreate`, `onAgentMessage`, `onToolCall`, etc.).
- Plugin-contributed MCP tools or HTTP endpoints.
- Per-agent or per-room enablement.
- Plugin marketplace, install/update commands, manifest validation against a schema.
- UI surfaces (a "Plugins" tab or settings panel).
- Auto-disabling Claude's `autoMemoryEnabled` setting (operator disables it manually in `~/.claude/settings.json`).
- A published `@isomux/plugin-types` package. Plugins re-declare types until the API stabilizes.

For the mem0 plugin:
- Mem0 OSS (Qdrant + embedder + extractor LLM swap). Cloud mode in v0; OSS is a later iteration when more interview substance is wanted.
- Scope classifier (auto-deciding office/room/user/agent tier for each extracted fact). Every fact is stored under the boss's `user_id` in v0.
- Plugin-side filtering of which turns to skip (e.g. skill expansions, queued messages). v0 runs on every turn.

---

## Part A: Plugin system (isomux core)

### Hook contract

```ts
export type PluginTurnContext = {
  agentId: string;
  agentName: string;
  roomId: string;
  roomName: string;
  sessionId: string | null;  // null on the first turn before system_init
  cwd: string;
  username: string | null;   // null when no boss is attributed
  userId: string | null;
  visibleText: string;       // what the user typed (e.g. "/foo bar")
  sdkText: string;           // what's about to be sent to the backend, pre-prefix (e.g. expanded skill prompt)
};

export type PluginBeforeTurnResult = {
  promptPrefix?: string;     // prepended to sdkText, wrapped in delimiters by the hook bus
};

export type PluginAfterTurnInput = {
  status: "completed" | "failed" | "interrupted";
  userTextSent: string;      // the final string sent to the backend, post-prefix
  assistantText: string;
  newLogEntries: LogEntry[]; // entries produced during this turn (see shared/types.ts)
};

export interface IsomuxPlugin {
  id: string;                // must match plugin dir name; [a-z0-9_-]+
  beforeTurn?: (ctx: PluginTurnContext) => Promise<PluginBeforeTurnResult | void>;
  afterTurn?: (ctx: PluginTurnContext, input: PluginAfterTurnInput) => Promise<void>;
}
```

`visibleText` and `sdkText` differ when a skill expands or otherwise transforms the user's input. Plugins generally want `sdkText` (what the model will see) for retrieval queries; `visibleText` is provided for display or auditing purposes.

All `beforeTurn` invocations within a single turn see the **same** pre-prefix `sdkText`. Plugins do not see each other's prefixes during `beforeTurn` (they run in parallel against the same context). This keeps plugins independent.

**Why `promptPrefix`, not system prompt mutation.** `buildSystemPrompt()` only runs at `createSession()` / resume; there is no per-turn system prompt to mutate. The only per-turn surface is `session.send(text, attachments?)`. Plugins prepend context to the outgoing text with per-plugin delimiters emitted by the hook bus so prompt inspection and debugging stay possible:

```
--- begin plugin: mem0 ---
Nil prefers commas over em dashes
...
--- end plugin: mem0 ---

--- begin plugin: audit ---
(audit's prefix here)
--- end plugin: audit ---

User message:
<original sdkText>
```

This matches mem0's canonical usage pattern and avoids invasive backend-contract changes.

### Turn lifecycle integration

Multiple paths currently call `session.send()` directly: immediate `sendMessage`, queue-drain `flushQueue`, skill execution in `command-handlers.ts`, and `editMessage` fork resend. Wiring hooks at each site would guarantee partial behavior.

Introduce a central helper. The helper owns the exact string sent to the backend, so plugins observe what the model actually saw (e.g. expanded skill prompts, not the raw `/skill` invocation):

```ts
runAgentTurn({
  managed,
  visibleText,    // shown in chat log (e.g. "/foo bar")
  sdkText,        // pre-prefix text to send to the backend
  attachments,
  origin,         // "user" | "queued" | "skill" | "edit-fork"
})
```

Every model-turn path goes through `runAgentTurn`. The helper:

1. Builds `PluginTurnContext` from `managed.info`, including `visibleText` and `sdkText` as passed in.
2. Awaits any prior `managed.afterTurnPromise` before starting. This is the gate that guarantees the previous turn's post-turn work (memory writes, etc.) has landed.
3. Runs `beforeTurn` for each enabled plugin in alphabetical id order. Wraps each non-empty `promptPrefix` in `--- begin plugin: <id> ---` / `--- end plugin: <id> ---` delimiters and concatenates. On plugin throw or timeout: log to plugin-failure stream, continue with no prefix from that plugin.
4. Prepends the assembled prefix to `sdkText` with a `User message:` separator. `visibleText` is unaffected (chat log still shows what the user typed).
5. Snapshots the current `logCache` tail (length or last entry id) so the `afterTurn` payload can slice exactly the entries produced during this turn.
6. Calls `beginTurn` / `session.send` with the final post-prefix `sdkText`.
7. After turn resolution (whether `completed`, `failed`, or `interrupted`), builds `PluginAfterTurnInput`:
   - `userTextSent`: the final string passed to the backend (post-prefix). Plugins can strip their own delimiter block if they want to.
   - `assistantText`: the assistant's final text response (may be empty on interruption).
   - `newLogEntries`: slice of `logCache` from the snapshot taken in (5). Includes `tool_call`, `tool_result`, `error`, `system` entries — not just assistant text.
   - `status`: derived from the turn outcome.
8. Stores the `afterTurn` work as `managed.afterTurnPromise` (a `Promise<void>` that resolves when all plugins' `afterTurn` complete or time out). The promise is **cleared in `finally`** so that timeouts or plugin failures resolve cleanly and never poison future turns.

`afterTurn` runs on all three statuses (`completed` / `failed` / `interrupted`). Plugins choose what to do with each — memory plugins may store nothing on aborted turns but still get to observe the boundary.

Without (2) + (8), the queue path waits only on `pendingTurn`, which resolves on `turn_completed` and can race with caller-side post-turn code.

### Hook timeouts and cancellation

`Promise.race` against a timeout lets isomux continue; it does not cancel in-process work the plugin is still doing. Plugins are expected to be cooperative. For network calls, plugins should accept aborts themselves (pass their own `AbortSignal` to fetch). v0 documents this; no runtime enforcement.

Defaults:

- `beforeTurn` timeout: 5s. On timeout: log, no prefix from that plugin, turn proceeds.
- `afterTurn` timeout: 10s. On timeout: log, the `afterTurnPromise` resolves so the next turn isn't blocked indefinitely.

### Discovery and loading

No directory scanning. `office-config.json`'s `enabledPlugins` array is the authoritative trust boundary: any directory whose code will be imported into the isomux process must be listed there explicitly. Two entry shapes:

1. **Bare string id** — `"safety-hooks"`. A bundled, first-party plugin. Resolved under `<isomuxRoot>/plugins/<id>/index.ts`. No path needed; the location is part of the isomux distribution.
2. **`{id, path}` object** — `{ "id": "mem0", "path": "/home/nil/nil/isomux-mem0" }`. An external plugin at an operator-controlled location. `path` must be absolute (`/...`) or tilde-prefixed (`~/...`); relative paths are rejected because they'd resolve against the server cwd. `basename(path)` does NOT have to match `id` — the mem0 repo lives at a directory called `isomux-mem0` but exports id `"mem0"`.

For each entry:

- Validate the entry shape (handled in `loadEnabledPlugins`, before the loader sees the list).
- Resolve `<dir>/index.ts` (`<isomuxRoot>/plugins/<id>/` for strings, `expandPath(path)` for objects).
- Resolve to realpath. Log realpath on load.
- Dynamic-import `<dir>/index.ts` via `file://` URL. Validate the module exports `id` equal to the configured id plus at least one of `beforeTurn` / `afterTurn`.
- Duplicate ids in `enabledPlugins` are caught in `loadEnabledPlugins` (first occurrence wins, error logged).

Why hybrid rather than discovery + symlink (the original design): configuration should describe all non-bundled code that will execute inside the isomux process. An explicit `path` in `office-config.json` is operationally clearer and easier to audit than "some directory happened to be discoverable via symlink." String entries preserve clean UX for bundled plugins that ship with the codebase.

Plugins load at boot, after persistence init, before agent spawn.

### Enable configuration

Office-wide `enabledPlugins: Array<string | { id: string; path: string }>` in `office-config.json`. See the entry shapes in *Discovery and loading* above.

Loading note: `OfficeSettings` currently filters unknown keys. A dedicated loader (`loadEnabledPlugins`) reads `office-config.json` directly rather than threading through `OfficeSettings`. It validates entry shape, dedupes by id, and logs malformed entries to stderr.

No UI in v0; users edit the file. Restart picks up changes.

### Failure logging

Plugin failures (load errors, hook throws, timeouts) write to a dedicated stream with structured fields: `pluginId`, `hook`, `durationMs`, `error`. No chat-log entries on normal failures — a noisy memory plugin would degrade core chat. Exact log destination: `~/.isomux/logs/plugins.jsonl` (align with existing log conventions during implementation).

### Trust model

Plugins run with full process privileges: they can read env, read/write filesystem, mutate global state, call out to the network. This is acceptable because plugins are operator-authored or operator-installed local code. The code-level disclaimer in `server/plugins.ts` and the README for plugin authors must state this explicitly.

---

## Part B: Reference plugin: mem0

The mem0 plugin is the first consumer of the plugin system and proves the contract end-to-end. It is **not** part of isomux. It lives in `~/nil/isomux-mem0/` (sibling to `~/nil/isomux/`), symlinked into `~/.isomux/plugins/mem0/`. It is **not committed to isomux's git history** and may be discarded after the underlying integration goal is served.

### Mem0 mode: cloud

v0 uses mem0 cloud (`api.mem0.ai`) via the `mem0ai` JS SDK. One env var:

- `MEM0_API_KEY` — read by the plugin's `client.ts`.

Mem0 OSS (Qdrant + embedder + extractor LLM) is a later iteration. The interview-substance value of OSS is real (custom extraction prompt, vector DB choice, embedder swap) but unnecessary to prove the integration.

### File layout

```
~/nil/isomux-mem0/
  index.ts          # exports id, beforeTurn, afterTurn
  client.ts         # thin wrapper over mem0ai SDK; identity translation
  types.ts          # re-declared PluginTurnContext / PluginAfterTurnInput / etc.
  package.json      # one dep: mem0ai
  README.md         # operator setup (install, env var, symlink, enable)
  .gitignore        # node_modules/
```

`bun install` is run inside the plugin dir to populate its own `node_modules/`. The plugin's deps are isolated from isomux's `bun.lock`.

### Identity mapping

mem0's flat `user_id` / `agent_id` / `run_id` tags map to isomux's hierarchy as follows:

| mem0 | isomux source | Fallback |
|---|---|---|
| `user_id` | `ctx.username` | `"__unassigned__"` if null |
| `agent_id` | `ctx.agentId` | — |
| `run_id` | `ctx.sessionId` | `"__pending__"` if null (rare; first turn before system_init) |
| `metadata.room` | `ctx.roomName` | — |
| `metadata.cwd` | `ctx.cwd` | — |

No scope classifier in v0: every extracted fact is stored under the boss's `user_id` regardless of whether it might better belong office-wide or room-wide. Adding a classifier later requires mem0's `custom_fact_extraction_prompt` + an extra LLM call, both out of v0 scope.

### Hook implementations

**`beforeTurn(ctx)`**:

1. Build the query from `ctx.sdkText` (what the model is about to see).
2. Call `client.search({ query, user_id, agent_id, limit: 5 })`.
3. If results, format as:
   ```
   Relevant facts retrieved from memory:
   - <memory text 1>
   - <memory text 2>
   ...
   ```
4. Return `{ promptPrefix: <formatted string> }`. If no results, return `void`.
5. Errors: log to the plugin failure stream, return void. Don't fail the turn.

**`afterTurn(ctx, input)`**:

1. If `input.status !== "completed"`, return without writing. (v0 choice; could revisit.)
2. Build the message list for mem0's extractor from `input.userTextSent` and `input.assistantText`:
   ```ts
   [
     { role: "user", content: input.userTextSent },
     { role: "assistant", content: input.assistantText },
   ]
   ```
3. Call `client.add(messages, { user_id, agent_id, run_id, metadata })`. mem0 cloud handles extraction, dedup, and storage server-side.
4. Errors: log to the plugin failure stream, return. Don't propagate.

`newLogEntries` is available but unused in v0 — the assistant's final text plus the user's sent text is sufficient for cloud-mode extraction. A future iteration could pass tool calls through mem0's extractor for richer facts.

### Operator setup

One-time:

1. `git clone <wherever> ~/nil/isomux-mem0` (or initialize fresh and commit there).
2. `cd ~/nil/isomux-mem0 && bun install`.
3. Make `MEM0_API_KEY` available to the isomux server process (e.g. `systemctl --user set-environment MEM0_API_KEY=m0-...` for non-persistent test setup, or `Environment="MEM0_API_KEY=..."` in the systemd unit file for persistence).
4. Edit `~/.isomux/office-config.json` to add the explicit-path entry:
   ```json
   "enabledPlugins": [
     { "id": "mem0", "path": "/home/nil/nil/isomux-mem0" }
   ]
   ```
5. (Recommended) Set `"autoMemoryEnabled": false` in `~/.claude/settings.json` to disable Claude's parallel auto-memory.
6. Restart isomux (`systemctl --user restart isomux`).

To disable: remove the `"mem0"` entry from `enabledPlugins` and restart. The plugin dir can stay in place.

No symlink. `office-config.json` is the single source of truth for what gets loaded; the loader reads the explicit `path` directly.

---

## Plugin placement convention (general)

Two trust paths, two enable shapes:

| Location | Purpose | Config entry | Tracked in git? |
|---|---|---|---|
| `<isomuxRoot>/plugins/<id>/` | Bundled first-party plugins, shipped with isomux | `"<id>"` (bare string) | Yes (in isomux repo) |
| Anywhere on disk | External plugins, operator-controlled | `{ "id": "...", "path": "/abs/..." }` | No (operator manages independently) |

The mem0 plugin lives at `~/nil/isomux-mem0/` and enables via the `{id, path}` shape pointing at that absolute path. No symlink; the loader imports from the path verbatim.

For v0, no plugins are bundled in `<isomuxRoot>/plugins/`. The directory is reserved for future first-party plugins (e.g. migrating `safety-hooks.ts` to dogfood the system).

## Acknowledged v0 tradeoffs

- **Latency on chained turns.** The `afterTurnPromise` gate means a queued message waits for the previous turn's `afterTurn` (plus timeout) before processing. Acceptable for v0. If it bites in practice, add an opt-out per plugin or per hook.
- **Plugin ordering is implicit.** Alphabetical by id, results concatenated. Plugins must not depend on each other. Documented; not enforced.
- **No cancellation of plugin work after timeout.** Documented constraint.
- **One throwing plugin doesn't fail the turn**, but it also gets no remediation other than the log entry. No retry, no auto-disable on N failures. Operator monitors logs.
- **Re-declared types in plugins.** Until the API stabilizes, plugins copy the type definitions. Migration to a published types package is a follow-up.
- **mem0 plugin stores everything under boss-tier.** No office or room scope until a classifier is added. Cross-boss leakage isn't a risk because the `user_id` partitioning isolates per-boss; the cost is that "office-wide" facts get duplicated per boss.
- **mem0 plugin skips writes on failed/interrupted turns.** Configurable in a later iteration; v0 keeps the rule simple.

## Future work (not v0)

For the plugin system:
- More hooks: `onAgentCreate`, `onAgentMessage`, `onToolCall`, `onSessionResume`.
- Per-agent and per-room enable.
- Out-of-process runtime (JSON-RPC over stdio) when language flexibility justifies it.
- MCP server registration from plugin manifests, so plugins can also expose agent-callable tools.
- UI surface (Plugins tab) for enable/disable, status, last-error display.
- Migration of existing in-core features that have hook shape: `safety-hooks.ts` is the obvious first candidate.
- Published `@isomux/plugin-types` package once the contract stops changing.

For the mem0 plugin:
- Mem0 OSS mode (Qdrant container, custom embedder, Claude as extractor LLM via LiteLLM).
- Scope classifier using `custom_fact_extraction_prompt` to emit `{fact, scope, confidence}` tuples; office/room/user/agent tier dispatch.
- Reserved `user_id="__office__"` for cross-boss office-tier facts.
- Pass `newLogEntries` (including tool calls) into mem0's extractor for richer fact capture.
- Per-agent enable/disable once the plugin system supports it.

## Implementation footprint

Estimated, for tracking. Split by repo.

### Isomux (main repo)

| Area | Files | Lines |
|---|---|---|
| Loader | `server/plugins.ts` (new) | ~120 |
| Hook bus + `runAgentTurn` helper | `server/plugin-hooks.ts` (new) | ~120 |
| Integration | `server/agent-manager.ts`, `server/command-handlers.ts` (call sites moved to helper) | ~80 |
| Types | `shared/types.ts` (additions) | ~40 |
| Config loader | `server/persistence.ts` | ~20 |
| Boot wiring | `server/index.ts` | ~10 |
| Tests | tiny fixture plugin in `server/__tests__/plugins/` or temp dir; loader + hook bus unit tests | ~80 |

Net new code in isomux: ~400 lines. Net changed code: ~80 lines refactored into the central helper.

The fixture plugin used for testing is a no-op or trivial echo plugin — **not** the mem0 plugin. The mem0 plugin lives outside the isomux repo and is not part of the loader's test surface.

### Mem0 plugin (`~/nil/isomux-mem0/`)

| File | Lines |
|---|---|
| `index.ts` | ~40 |
| `client.ts` | ~70 |
| `types.ts` | ~30 |
| `package.json` | ~10 |
| `README.md` | ~40 |

Net code: ~190 lines plus deps.
