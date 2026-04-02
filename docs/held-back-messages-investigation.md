# Held-Back Messages Bug Investigation

**Date**: 2026-04-01
**Status**: Unresolved (SDK limitation)
**Related commits**: `4b7ba76` (abort-race fix), `9c7600e` (stuck-thinking fix)

## The Bug

Bot responses sometimes get "held up" and don't appear in the UI until the next user message is sent. When they do appear, they arrive instantly (proving they were already generated), and they appear as if answering the previous request rather than the current one — an off-by-one response.

## Reproduction

1. Send a message that triggers a `run_in_background` Bash command (e.g., `sleep 5`)
2. Wait for the background task to complete
3. Send a new message
4. Observe: the response to the background task completion appears first (instantly), followed later by the response to the actual new message

Example from a real conversation:
```
User: "serve the site over 8080 to test"
Agent: [runs python3 -m http.server 8080 in background] "Serving at http://localhost:8080"
  -- background task completes, but no output appears --
User: "explain how the counter gets updated?"
Agent: "Looks like it exited immediately. Let me restart it properly." ← stale response to bg task
  -- later --
Agent: [actual answer about the counter] ← response to user's real question
```

## Root Cause

### Architecture

`sendMessage` in `agent-manager.ts` follows this flow:
1. `addLogEntry("user_message", ...)` — log the user's message
2. `session.send(text)` — send to SDK
3. `consumeStream()` — iterate `session.stream()` to process the response

`consumeStream` is only called inside `sendMessage` (and `executeSkill`). Between user messages, **nobody is consuming the stream**.

### SDK internals (from Claude Code source analysis)

The Claude Agent SDK's `session.stream()` returns a `Stream<T>` backed by an internal queue. Key findings:

1. **Single iterator**: `stream()` returns `this` from `[Symbol.asyncIterator]()`. Calling `stream()` multiple times returns the **same generator**. Two concurrent `for await` loops would race for messages.

2. **Stream stays open across turns**: A `result` message does NOT close the generator. The stream only ends when `end()` is called explicitly.

3. **Task notifications are drained lazily**: Background task completions (`SDKTaskNotificationMessage`) are buffered in a bounded circular queue (`utils/sdkEventQueue.ts`, max 1000 events). They are **not pushed in real-time**. They are batch-drained at specific checkpoints in the print loop (`cli/print.ts`) — typically when processing the next turn's output.

4. **No peek API**: The `Stream<T>` class has no public way to check for pending messages without consuming them.

### The failure sequence

1. User sends message, `consumeStream` iterates the stream
2. Claude responds, runs a background Bash command
3. Stream yields: assistant messages, tool results, text response, `result` message
4. Stream continues to stay open, but `consumeStream`'s `for await` loop has processed the `result` and the stream yields no more messages — loop exits naturally
5. Background task completes later
6. SDK buffers the `task_notification` in `sdkEventQueue` — but the notification is **not drained** because the print loop isn't running
7. User sends a new message: `session.send()` triggers the print loop
8. Print loop drains the stale `task_notification` into the stream
9. `consumeStream` processes the stale response first (it was queued before the new response)
10. User message was already logged at step 1 of `sendMessage`, so it appears above the stale response in the UI

## Approaches Tried

### 1. Persistent stream consumer

**Idea**: Replace per-send `consumeStream` with a fire-and-forget async loop that runs for the session lifetime. `sendMessage` only calls `session.send()`.

**Result**: Broke Isomux. The persistent consumer exited when the stream yielded no more messages after a turn (the generator pauses, not ends). When no one is sending, the consumer is suspended. The stale notifications still only arrive when the next `send()` triggers the drain — so this approach didn't help. Additionally, removing the `await consumeStream()` from `sendMessage` changed the function's completion semantics.

**Reverted**.

### 2. Flush-before-send with separate stream() call

**Idea**: Before `session.send()`, call `session.stream()` to create a new iterator and drain any pending messages with a timeout.

**Result**: Corrupted the stream state. Since `stream()` returns the same underlying iterator (not a new one), the flush's abandoned `.next()` promise could steal messages from the main `consumeStream`. Broke all agent communication.

**Reverted**.

### 3. Deferred user message insertion

**Idea**: Don't log the user message immediately. Pass it to `consumeStream` as a deferred entry. Insert it at the boundary between stale content (`result` message) and fresh content (first `assistant` message).

**Result**: Logically correct ordering, but introduced a UX regression: the user's message didn't appear in the UI until the SDK started streaming back (after `session.send()` + API latency). Users saw no feedback for several seconds after hitting send.

**Reverted**.

### 4. Timestamp-based UI sorting

**Idea**: Render messages in the UI sorted by timestamp. Stale messages would have earlier timestamps and naturally sort before the user's message.

**Result**: Not viable. All timestamps are set by `addLogEntry` at processing time (`Date.now()`), not at generation time. Stale messages get current timestamps when drained through `consumeStream`, so they sort AFTER the user message — same broken order. The SDK only provides original timestamps on `user` type messages, not `assistant` or `result`.

## Why Previous Fixes Didn't Help

Commits `4b7ba76` and `9c7600e` fixed **abort-related** races:
- Stale async callbacks clobbering flags (`streamGeneration` counter)
- Post-abort stream errors causing off-by-one responses
- Stuck thinking state after abort

These are orthogonal to the held-back messages bug, which involves **no abort at all** — just background task completions arriving between user turns.

## What Would Fix This

### SDK-level fix (preferred)
The SDK should drain `sdkEventQueue` eagerly (e.g., on a timer or immediately when events arrive) rather than lazily during the print loop. This would push task notifications through `stream()` as they happen, and any stream consumer (even the current per-send `consumeStream`) would pick them up.

### SDK enhancement: original timestamps on all message types
If `SDKAssistantMessage` and `SDKResultMessage` included an original `timestamp` field (like `SDKUserMessage` already does), the UI could sort by original timestamp and the ordering would be correct without any server changes.

### Server-level workaround: optimistic UI + reorder events
Log the user message immediately (instant UI feedback), then when `consumeStream` detects stale messages (a `result` before any `assistant` from the current turn), emit a reorder event to the UI to move stale entries above the user message. This requires a new event type and splice logic in the store — feasible but fragile.

## Key SDK Constraints to Remember

- `session.stream()` returns the **same iterator** every time — never create two consumers
- The stream **stays open** across turns; it doesn't end at `result`
- Task notifications are **lazily drained** — they only flow when the print loop runs
- No public API to peek at pending messages
- Only `SDKUserMessage` has an original `timestamp` field
