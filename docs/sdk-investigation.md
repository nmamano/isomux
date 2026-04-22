# Agent SDK Investigation

Research conducted 2026-03-26 against `@anthropic-ai/claude-agent-sdk@0.2.85`.
Updated 2026-03-27 with live testing results.

## Summary

The Agent SDK works with a Claude Pro/Max subscription despite docs saying it requires an API key. **Tested and confirmed**: both V1 `query()` and V2 `unstable_v2_createSession()` work with subscription auth, including multi-turn. The SDK is our primary integration path.

---

## Live Test Results (2026-03-27)

**V1 `query()`**: Passed. No `ANTHROPIC_API_KEY` set. Subscription rate limits applied (`rateLimitType: "five_hour"`). Result in 1.7s.

**V2 `unstable_v2_createSession()`**: Passed. Multi-turn works — two `send()`/`stream()` cycles on the same session, context preserved across turns. Same session ID throughout.

**Why it works**: The SDK spawns the Claude Code CLI as a subprocess. The CLI uses whatever auth is configured — including subscription via `claude login`. The docs' API key requirement is a policy for third-party distribution, not a technical enforcement.

---

## Feature Matrix

| Feature                 | Supported        | Details                                                     |
| ----------------------- | ---------------- | ----------------------------------------------------------- |
| **Auth: subscription**  | **YES** (tested) | Uses CLI's auth; docs say API key required but not enforced |
| **Multi-turn (V2)**     | **YES** (tested) | `send()`/`stream()` cycles on `SDKSession`                  |
| **Multi-turn (V1)**     | YES              | `query()` with `resume: sessionId`                          |
| **Streaming output**    | YES              | `includePartialMessages: true` for token-level events       |
| **Permission callback** | YES              | `canUseTool` async callback blocks agent until resolved     |
| **State derivation**    | YES              | Stream events: `text_delta`, `tool_use`, `tool_progress`    |
| **Cost tracking**       | YES              | `total_cost_usd` on result, per-turn usage                  |
| **Tool allow/deny**     | YES              | `allowedTools`, `disallowedTools`                           |
| **Bun compatible**      | YES              | First-class `executable: 'bun'` option                      |
| **Session persistence** | YES              | JSONL on disk, resume by ID                                 |

---

## Authentication Note

The SDK docs explicitly state:

> **Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead.**

This is a **distribution policy**, not a technical constraint. Since isomux is a personal local tool (not distributed to third parties), this restriction does not apply. The SDK uses the CLI's auth, which works with subscriptions.

---

## CLI Headless Mode Details

### Basic usage

```bash
claude -p "What files are here?" --output-format json
# Returns: { result, session_id, total_cost_usd, usage, ... }
```

### Streaming

```bash
claude -p "Refactor auth module" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages
# Emits NDJSON: one JSON object per event (text_delta, tool_use, tool_progress, result, etc.)
```

### Multi-turn

```bash
# Turn 1
SESSION=$(claude -p "Analyze the codebase" --output-format json | jq -r '.session_id')

# Turn 2
claude -p "Now fix the bug we discussed" --resume "$SESSION" --output-format stream-json
```

### Permission control

```bash
claude -p "Deploy to staging" \
  --allowedTools "Bash,Read,Glob,Grep" \
  --permission-mode default \
  --permission-prompt-tool "mcp_server:approval_tool"
```

### Useful flags

- `--max-budget-usd 5.00` — per-session cost cap
- `--max-turns 50` — turn limit
- `--model claude-opus-4-6` — model selection
- `--system-prompt "..."` — custom system prompt
- `--bare` — fast startup, skips config/MCP discovery
- `--worktree` — isolated git worktree per session

### Bidirectional streaming (undocumented)

```bash
claude -p --input-format stream-json --output-format stream-json
# stdin: {"type":"user","message":{"role":"user","content":"..."},"session_id":"..."}
# stdin: {"type":"control_response", ...}  (for permission responses)
# stdout: NDJSON events
```

This protocol exists but is [undocumented (GitHub issue #24594)](https://github.com/anthropics/claude-code/issues/24594). Third-party projects have reverse-engineered it. It could change between versions.

---

## Stream Event Types (same for SDK and CLI)

When streaming, the following event types are emitted:

| Event                     | Use for                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `system` (subtype `init`) | Session start — model, tools, cwd                                      |
| `assistant`               | Full assistant message with content blocks (text, tool_use)            |
| `stream_event`            | Token-level deltas: `text_delta`, `thinking_delta`, `input_json_delta` |
| `tool_progress`           | Heartbeat during tool execution — includes `elapsed_time_seconds`      |
| `result`                  | Final message — `total_cost_usd`, `usage`, `session_id`                |
| `rate_limit_event`        | Rate limit status: `allowed`, `allowed_warning`, `rejected`            |

### State derivation from events

```text
init message received     → starting
stream_event text_delta   → thinking/generating
stream_event tool_use     → calling tool
tool_progress             → executing tool (with timer)
canUseTool / control_req  → waiting for permission
result (success)          → idle
result (error)            → error
```

---

## Launcher Scripts: Why They're Necessary (2026-03-29)

**Question**: Can we eliminate the per-agent `.mjs` launcher scripts in `~/.isomux/launchers/` by passing `systemPrompt`/`appendSystemPrompt` and `cwd` directly through `SDKSessionOptions`?

**Answer**: No. Tested against `@anthropic-ai/claude-agent-sdk@0.2.85` — the launcher scripts are required.

### What the launchers do

Each launcher script (e.g. `agent-xxx.mjs`) does three things before the CLI boots:

1. `process.chdir(cwd)` — sets the working directory
2. `process.argv.push("--append-system-prompt", ...)` — injects the agent identity/instructions
3. `await import(CLI_PATH)` — starts the CLI

These are passed to the SDK via `pathToClaudeCodeExecutable` in `SDKSessionOptions`.

### What was tested

| Approach                                          | Result                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `appendSystemPrompt` in `SDKSessionOptions`       | **Silently ignored** — agent responded as "Claude", not custom name |
| `systemPrompt` in `SDKSessionOptions`             | **Silently ignored** — same result                                  |
| `cwd` in `SDKSessionOptions`                      | **Silently ignored** — cwd remained the process cwd, not `/tmp`     |
| `executableArgs: ["--append-system-prompt", ...]` | **Process exited with code 1**                                      |

### Why it doesn't work

- `SDKSessionOptions` only accepts: `model`, `pathToClaudeCodeExecutable`, `executable`, `executableArgs`, `env`, `allowedTools`, `disallowedTools`, `canUseTool`, `hooks`, `permissionMode`. No `cwd` or prompt fields.
- The SDK has an internal `initConfig` (with `appendSystemPrompt`, `systemPrompt`, `agents`, etc.) that feeds the `SDKControlInitializeRequest`, but it's set internally — `unstable_v2_createSession` takes a single `SDKSessionOptions` argument with no way to pass `initConfig`.
- Extra properties on the options object are silently stripped (likely Zod validation).

### Why the V2 path doesn't wire these through

Source inspection of `sdk.mjs` confirms: the V1 `query()` path constructs an `initConfig` with `systemPrompt`/`appendSystemPrompt` and passes it as the 8th argument to the internal `lX` class. The V2 `unstable_v2_createSession` path skips this entirely — it passes `false` and no `initConfig`. This is a V2 API gap, not a validation issue.

### Ephemeral launcher alternatives explored (2026-03-29)

Also tested whether launchers could be made ephemeral (write to `/dev/shm`, delete after `system:init` event):

- **Write to `/dev/shm` + delete after init**: Works for single sessions and multi-turn. But resume spawns a new process and needs the file again, so you're writing just as many files — just to RAM instead of disk.
- **Delete immediately after spawn**: Fails — subprocess hasn't read the file yet (race condition).
- **`/dev/shm` is Linux-only**: No macOS support without fallback to `os.tmpdir()`.

**Decision**: Keep persistent launchers in `~/.isomux/launchers/`. Solve stale file accumulation with startup pruning (wipe dir before regenerating) and cleanup on agent destroy. Launchers are fully derived from persisted agent config, so there's zero information loss.

### Conclusion

The launcher script approach is the only working mechanism to customize agent identity and working directory in the V2 SDK. This will remain necessary until Anthropic exposes `appendSystemPrompt` and `cwd` in `SDKSessionOptions` (or adds a public `initConfig` parameter).
