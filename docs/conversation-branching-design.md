# Conversation Branching (Edit & Fork)

Design doc for editing a past user message to branch the conversation from that point.

## SDK Primitives (v0.2.86)

All required APIs exist in `@anthropic-ai/claude-agent-sdk@0.2.86`:

- **`forkSession(sessionId, { upToMessageId, dir?, title? })`** — copies transcript up to a specific message UUID, remaps UUIDs, returns `{ sessionId }`. The new session is immediately resumable.
- **`unstable_v2_resumeSession(sessionId, opts)`** — resumes a forked (or any) session. Accepts `resumeSessionAt` option to resume only up to a specific message UUID.
- **`getSessionMessages(sessionId, { dir?, limit?, offset? })`** — reads the transcript JSONL, returns `SessionMessage[]` with `{ type, uuid, session_id, message, parent_tool_use_id }`.
- **`session.send(string | SDKUserMessage)`** — sends a message. Returns `Promise<void>` (no UUID returned). `SDKUserMessage` has an optional `uuid` field.
- **`enableFileCheckpointing` / `query.rewindFiles()`** — exist but ruled out (see below).

## Core Flow

1. User clicks "edit" on a past user message
2. Inline textarea appears pre-filled with original text; Send/Cancel buttons
3. On Send, UI sends `{ type: "edit_message", agentId, logEntryId, newText }` via WebSocket
4. Server looks up `LogEntry.metadata.sdkMessageUuid`
5. Server calls `forkSession(currentSessionId, { upToMessageId: sdkMessageUuid })`
6. Server persists fork metadata in sessions map
7. Server closes old session, calls `createSession(managed, newSessionId)` to resume the fork
8. Server clears UI logs, replays parent chain entries up to (excluding) the edited message
9. Server sends edited text via `session.send(newText)`, then `consumeStream()`

## Decisions

### Fork-then-resume, not destructive rewind

Fork preserves the original conversation as a separate session. `resumeSessionAt` alone would destructively rewind — rejected.

### No file checkpointing

`enableFileCheckpointing` and `rewindFiles` are designed for single-agent environments where one session "owns" the filesystem. In isomux, multiple agents share a filesystem and files have lifetimes independent of sessions. Rewinding files to a conversation checkpoint would be nonsensical and potentially destructive. **Ruled out entirely — not even as a follow-up.**

### No log duplication — reference-based display

Forked session's JSONL only contains entries from the branch point onward. Display walks the `forkedFrom` chain to assemble the full view. This avoids polluting search results and disk with duplicated log entries.

**Sessions map entry for forked sessions:**

```typescript
{
  topic: string | null;
  lastModified: number;
  forkedFrom?: string;      // parent sessionId
  forkMessageId?: string;   // LogEntry ID of the edited message (in parent's log)
}
```

**Display logic:** Walk the `forkedFrom` chain. For each ancestor, load its JSONL and take entries _before_ `forkMessageId` (excluding it). Concatenate ancestors (oldest first), then append the fork's own JSONL. This handles editing the first message (zero parent entries) and recursive forks (chain of length N).

### Recursive forks supported

Branching from a branch works. The display logic walks the full `forkedFrom` chain. Chain depth is typically 1-2 levels.

### Edited message is text-only

Attachments from the original message are dropped in the fork. The user can add attachments in a follow-up message on the new branch. Simplifies implementation — no attachment picker in edit mode, no attachment preservation logic.

### Topic: inherit and mark stale

Forked session inherits the parent's topic immediately (so it's identifiable in the resume list). Topic is marked stale so the normal regeneration logic kicks in after the first exchange on the branch.

### System log entry at branch point

The fork's own JSONL starts with a system LogEntry: `"Branched from: [parent topic]"`. Appears right before the edited message in the UI, giving the user context.

### Edit button placement

Added next to the existing copy button on user messages (top-right of user message bubble). Same visual style. Only visible when agent is in `waiting_for_response` state — no edit while the agent is streaming.

### Edit button on all user messages

Including the first message. Editing the first message creates a branch with zero parent entries — equivalent to starting a new conversation with different text, but preserving the original.

### Error handling

The entire fork flow is wrapped in try/catch. If anything fails before closing the old session, an error log entry is emitted and the user stays in their current conversation. No partial state changes.

### Resume list: dim branched-from sessions

Sessions that have been branched FROM (i.e., their sessionId appears as another session's `forkedFrom`) are dimmed and marked "(branched)" in the `/resume` list. The fork (child) looks normal — it's the continuation. Detection is done server-side by scanning all sessions; `SessionInfo` gets a `branched?: boolean` field.

### Edit state is component-local

`editingLogEntryId: string | null` in LogView. Bottom input bar disables itself when an edit is active.

## Client Command

```typescript
// Added to ClientCommand union
| { type: "edit_message"; agentId: string; logEntryId: string; newText: string }
```

## Type Changes

```typescript
// SessionInfo — add branched flag for resume list
export interface SessionInfo {
  sessionId: string;
  lastModified: number;
  topic: string | null;
  branched?: boolean;  // true if another session was forked from this one
}

// LogEntry.metadata — store SDK UUID on user messages
metadata: {
  sdkMessageUuid?: string;  // SDK-assigned UUID, needed for forkSession
  // ... existing fields
}
```

## Outstanding Items

### How to obtain SDK message UUIDs for user messages

**Resolved via experiments (Isomuxer3, 2026-04-06).** We need the SDK's internal UUID for each boss-typed user message to pass to `forkSession({ upToMessageId })`.

**The problem:** `session.send()` returns `Promise<void>` — no UUID comes back. Streaming events include UUIDs on `assistant`, `system`, `result`, and `rate_limit_event` types, but **never on user messages** (user messages are sent, not received). The only way to get user message UUIDs is `getSessionMessages()`.

**Verified experimentally:**

- `getSessionMessages(sessionId)` works while the session is open (not just after close). It's a file read — fast.
- `getSessionMessages` returns both user and assistant messages with UUIDs, in chronological order. Each turn produces ~2 assistant entries (thinking + response).
- `forkSession(sessionId, { upToMessageId })` works correctly — tested with a 3-turn conversation (ALPHA→BETA→GAMMA), forking at the BETA user message produced a 4-message session (ALPHA exchange + BETA user msg). Resuming the fork and sending a new message worked.
- `resumeSessionAt` with `forkSession: true` does **NOT** work for branching — it resumes the original session and appends to it. Destructive. Ruled out.
- Assistant UUIDs from streaming events **do** match those from `getSessionMessages` (verified).

#### Chosen approach: lazy match at fork time using (content, occurrence_count)

When the user clicks edit, call `getSessionMessages(sessionId)` and match the target LogEntry to an SDK `SessionMessage` by:

1. **Content match** — reconstruct the prefixed form sent to the SDK. Our LogEntry stores raw `text` in `content` and `username` in `metadata.username`. The SDK received `[username] text` (see `agent-manager.ts:1168`). Match against the text content in `SessionMessage.message`.
2. **Occurrence index** — if the same content appears multiple times (e.g. user sent "commit" twice), count which Nth occurrence of that exact content this LogEntry is among all `user_message` LogEntries, then pick the Nth matching `type: 'user'` `SessionMessage`.

This is a unique key — no ambiguity possible. No per-message overhead, no stored UUIDs needed. The `getSessionMessages` call only happens on edit (rare, user-initiated).

### Edge cases to handle in implementation

- Agent in `error` state: edit button should not appear (agent is idle but session may be broken)
- Session is `null` (not yet initialized): edit button should not appear
- Agent has no `sessionId` yet (pre-init): edit button should not appear
- Race condition: user clicks edit, agent receives a message from another source before fork completes — mitigated by the `waiting_for_response` state check
