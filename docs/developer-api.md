---
title: Isomux developer API resources
description: Machine-readable API, authentication, and error references for Isomux developers and agents.
order: 7
navTitle: Developer API
---

# Isomux developer API resources

The [Isomux OpenAPI specification](/openapi.json) describes the public API on isomux.com. The website currently exposes one endpoint, `POST /api/chat`, which streams answers about Isomux as server-sent events.

Self-hosted and hosted Isomux offices also expose a room-scoped REST API for agents and signed-in members. Each office injects exact API instructions and its bearer token into its agents. Browser clients use the office session cookie. Start with [access and invites](/docs/access-and-invites) for the authentication model and the [GitHub route table](https://github.com/nmamano/isomux/blob/main/server/routes/table.ts) for the current source-level contract.

`POST /api/agents` and `PATCH /api/agents/:id` keep `modelFamily` and `model` consistent. With only `model`, Isomux derives `modelFamily`: Claude uses its exact family map, while Codex and OpenCode store the model ID as the family. With both fields, they must agree. Claude accepts its known families. Codex refuses Claude-shaped names but accepts other slugs because its model list depends on the connected account. OpenCode accepts a well-formed `provider/model` ID because its connected model list is available only at runtime.

`GET /api/agents/:id/system-prompt` returns `{ "prompt": "..." }` for a live agent. The caller must be authenticated and have access to the agent's room. Isomux returns the same `403` response for an inaccessible or unknown agent that it uses for `GET /api/agents/:id/instructions`.

`POST /api/agents/system-prompt-preview` returns the same envelope without saving. The body contains `roomId`, `name`, `agentType`, `customInstructions`, and `privileged`, with optional `agentId` and `memory`. The caller must have access to `roomId`; an existing agent must belong to that room. Edit previews use the agent's manager and draft memory (an empty string clears it in the preview; omission uses saved memory). Spawn previews use the caller's member context, empty agent memory, and `new-agent` as a placeholder ID.

`GET /api/cronjobs/:id/system-prompt` returns `{ "systemPrompt": "...", "firstUserMessage": "..." }` for a cronjob. The first field is assembled from the current office and cronjob settings, and the second field is the cronjob's configured prompt. The route uses the same `cron:read` guard as `GET /api/cronjobs/:id` and returns `404` when the cronjob does not exist.

An agent can inspect current limits for any agent in a room its manager can access. `GET /api/agents/:id/context` returns the latest context-window measurement. `GET /api/agents/:id/subscription` asks the provider when the target has a live session, then returns the plan and every subscription window with its usage and reset time. It also returns `observedAtMs`, when Isomux received the reading from the provider, and `ageMs` since then. `freshness` is `fresh` when the provider interaction completed for this call and the account stayed unchanged. It is `cached` when there is no live session or the refresh could not produce a current, valid answer; a cached reading carries `staleReason` `no_session` or `refresh_failed`. When there is no reading at all, `available` is false with `reason` `no_session`, `not_yet_measured`, or `provider_unavailable`. OpenCode reports `provider_unavailable` because its adapter does not provide subscription allowance. Both routes require authentication and use the same room access as the conversation-log route.

## Message an agent from another device

One token = one inbox = one conversation. The token talks to any number of agents; everything it sends and everything it receives lives in one append-only log for that token, in order, each entry with an increasing sequence number.

In **Settings → You → API tokens**, create a named token with a 30-day expiry, a 365-day expiry, or no expiry. Copy the raw token when it appears; Isomux does not show it again. Set your office URL and paste the token into your shell:

```bash
OFFICE_URL="https://office.example.com"
TOKEN="paste-the-token-shown-once"

curl -s "$OFFICE_URL/agents" \
  -H "Authorization: Bearer $TOKEN"
```

The response lists the live agents in rooms you can access, plus the lobby agent (`room: null`, `roomName: "Lobby"`, `roomId: "lobby"`). Copy the target agent's `id`, and then send the message:

```bash
AGENT_ID="agent-123"

curl -s -X POST "$OFFICE_URL/api/agents/$AGENT_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Please check the latest alert."}'
```

The send response contains `messageId`, which is also the `id` of the send entry in the token log.

For example, the agent sees a message as `[Member (API token "Phone 'alerts" (pat-123))]`. If the target agent is waiting for a permission answer, the next API-token message to that agent is used as the answer instead of a new chat message. A token has the issuing user's operational reach: agents and their conversations, rooms, tasks, apps, logs, schedules, editor and file actions, memory, and office reads. It cannot mint durable access, revoke browser sessions, change user access or office settings, or grant the privileged-agent flag. These exclusions are defense in depth: a token can spawn an agent that runs commands. Room access and the issuing user's current role are checked on every request. An expired or revoked token stops working immediately.

## Members chat

Members, their API tokens and privileged agents can read and post to the office-wide members chat. Ordinary agents, scheduled runs and apps have no `chat:members` capability.

- `GET /api/members-chat?before=<message-id>&limit=100` returns `messages`, `hasMore`, `readPointer`, `unread` and `pinned`. Messages are in chronological order. `pinned` holds up to 21 live pinned messages from all history, newest `pinnedAt` first; the extra entry lets a client distinguish exactly 20 from more than 20.
- `POST /api/members-chat` accepts `{"text":"..."}`, optional uploaded `attachments`, and optional `replyTo` (an existing message id). The server stores `replyTo: {id, userName, excerpt}` on the message. The excerpt holds the first 200 Unicode characters of the target text, or its attachment names when it has no text. Edits and deletion of the target leave this snapshot unchanged. An unknown or deleted target returns `404 reply_not_found`.
- `PATCH /api/members-chat/:id` accepts `{"text":"..."}` and edits the caller's own post.
- `PUT /api/members-chat/:id/thumbs-up` accepts `{"active":true}` to set the caller’s thumbs up, or `{"active":false}` to remove it. Repeating either request keeps that state.
- `PUT /api/members-chat/:id/pin` accepts `{"active":true}` or `{"active":false}`. Anyone who can post can pin or unpin. Pinning sets `pinnedAt`; unpinning removes it. Repeating the current state preserves the timestamp. Deleting a message also removes its pin.
- `DELETE /api/members-chat/:id` deletes the caller's own post, or any post when the caller acts for an office owner.
- `POST /api/members-chat/read` accepts `{"lastReadId":"..."}` and updates that user's read pointer.
- `POST /api/members-chat/uploads` accepts multipart files; `GET /api/members-chat/files/:filename` reads an uploaded file.

Messages carry an optional `thumbsUp` list with each reactor’s `userId`, `userName`, `kind` and optional `device`. Identity comes from the session; agent and API reactions retain their non-human attribution. Edits, reactions and pin changes use `members_chat_message` with `updateOnly: true`. Clients update the pinned strip even when the message is not in the loaded page, without appending it to the conversation or raising unread. Clients can refresh the page response to refill the capped pinned list after a change.

## Receive replies from office agents

The incoming message label gives the agent the API token id it needs to reply:

```bash
curl -s -X POST "$OFFICE_URL/api/api-token-inboxes/$TOKEN_ID/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"The report is ready."}'
```

The send succeeds without a poller. Its response includes `messageId` and `lastDrainedAt`, or `null` for `lastDrainedAt` when the token has never read its log.

Connect to the office’s existing `/ws` WebSocket with an `Authorization: Bearer <token>` header. The server accepts no token in the URL, so the client must be able to set handshake headers.

The socket is receive-only. Send messages through REST. Each new send or reply produces one event:

```json
{
  "type": "api_token_log_entry",
  "tokenId": "pat-123",
  "entry": {
    "sequence": 124,
    "id": "message-123",
    "text": "The report is ready.",
    "direction": "from_agent",
    "senderAgentId": "agent-123",
    "senderAgentName": "Worker",
    "senderRoomName": "Isomux",
    "sentAt": 1788810481060
  }
}
```

`entry` is the same object the cursor read returns. The socket carries only this token’s entries and nothing else from the office. Revocation closes the socket.

There is no replay. Connect, buffer live events, then read from your saved cursor until `latestSequence` and merge by `sequence`. Do the same after a disconnect. The cursor read also serves clients that poll:

```bash
curl -s -X POST "$OFFICE_URL/api/me/api-token-inbox/drain" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"after":123}'
```

`after` is the last sequence the client has saved and processed; it defaults to 0 and must be a nonnegative safe integer. The response contains `entries`, `firstSequence`, `latestSequence`, `previouslyDrainedAt`, and `drainedAt`. Each read returns up to 500 entries with `sequence > after`, in sequence order. The client reads again from the last sequence it received until it reaches `latestSequence`. A cursor at or beyond `latestSequence` returns an empty `entries` array.

The send in the other direction - a client POSTing to `/api/agents/<id>/messages` with its token - answers with `messageId` and `sentAt`, the office's own timestamp on that message. It is the same instant the send's `to_agent` entry carries, so a client pairs its send with the agent's reply, and the time between them, without reading the log at all.

Every entry has `direction`, `sequence`, `id`, `sentAt`, and `text`. A `to_agent` entry records the token's send with `targetAgentId`, `targetAgentName`, and `targetRoomName`; its `id` matches the send response's `messageId`. A `from_agent` entry records a reply with `senderAgentId`, `senderAgentName`, and `senderRoomName`.

`latestSequence` is the last assigned sequence for the token, including entries removed by storage pruning; it is not the end of the page. `firstSequence` is the oldest sequence still in the log, or `latestSequence` when the log is empty. Both are 0 for a new token. The read timestamps keep their existing names: `drainedAt` is the current read time and `previouslyDrainedAt` is the previous read time, or `null`. These timestamps and `sentAt` are milliseconds since the Unix epoch.

Reading deletes nothing. A lost response costs nothing; the client asks again with the same cursor, as long as the owner has not pruned the log. There are no acknowledgements, inbox capacity, leases, or entry expiry. The log survives restarts. Existing retained inboxes migrate into the log in stored order on startup. If a write stops partway through a final line, recovery removes that incomplete line and keeps the complete entries before it. A corrupt complete line moves that token’s log to a quarantine file; other tokens keep working.

## Prune token conversations

Entries leave only through owner-driven storage pruning. The storage report counts token logs under **API token conversations**. The owner can preview or apply pruning in the storage panel, or call `POST /api/storage/prune` with `{"target":"token-logs","olderThanDays":30}`. This is a dry run; add `"apply":true` to delete the selected files. `olderThanDays` must be an integer of at least 1; `keepPerAgent` is ignored for token logs.

Pruning removes whole token log files by their last modification time. An active log stays in full until it has had no writes for the selected number of days. Revocation leaves the log in storage; the owner can prune it under the same rules. Pruning preserves the token's sequence counter, so later entries continue above it.

A client with `after < firstSequence - 1` has missed pruned entries. An empty page with `after < latestSequence` also means entries were pruned. The client must handle that gap; reading again cannot recover deleted entries.

## Retry a request

Send an `Idempotency-Key` header on a message send or drain, and reuse that key with the exact same request body when retrying that request. A successful retry returns the cached response with `Idempotency-Replayed: true`; a changed body returns `409 idempotency_conflict`. Use a new key for each new request, including each new poll. API-token sends reject `clientMessageId` with a 400 that names `Idempotency-Key`.

The cache is in memory for five minutes after completion and is cleared on restart. It covers sends to agents, agent replies to token inboxes, and drains. It does not make delivery and persistence atomic or prevent duplicates after an error. Token logs remain until the owner prunes them.

A send can reach its destination before all log writes complete. If the send returns an error after delivery, a retry can create a duplicate.

## Read and write memory

`GET /api/memory?scope=agent` returns the scope's raw `text`, optimistic-concurrency
`version`, current injected `size`, and `cap`. For `agent`, an agent token may omit
`scopeId` to target itself; a signed-in user must name an existing agent. `room`
requires an existing `scopeId`. `office` rejects `scopeId`. For `boss`, an omitted
`scopeId` targets the caller's user or the agent's manager; an explicit id must
name an existing user.

`POST /api/memory` accepts `{ scope, scopeId?, text }` and appends one
server-stamped trigger. The text must fit on one line of at most 400 characters.
The response returns `{ item, version, size, cap }`, where `size` and `cap` show
the scope's post-write cost. A duplicate returns 409. A line or scope-cap failure
returns 422. If a scope is full, trim your own lines, propose the rest to a member,
or drop the note; do not move it to a wider scope. Do not make big changes to
office memory.

`PUT /api/memory` accepts `{ scope, scopeId?, text, version }` and replaces the
raw file. Use the version from GET. A stale version returns 409. REPLACE is the
curation path and does not apply the 400-character APPEND limit.

## Update a room

`PATCH /api/rooms/<roomId>` is a partial update over a room's cosmetic fields.
Send `name`, `pet`, `skin`, or any mix; each is applied only when the body
carries it.

`skin` is the look the room is drawn in: `"office"` (the default) or
`"hospital"`. `null` restores the office look. An unknown value returns 422
`invalid_skin`. The lobby draws its own scene and takes no skin: it returns 422
`skin_not_supported` whatever the value is. `POST /api/rooms` takes the same
`skin` at creation.

API failures use JSON with an `error` object:

```json
{
  "error": {
    "code": "not_found",
    "message": "No API endpoint exists at /api/example.",
    "resolution": "Read https://isomux.com/openapi.json for supported endpoints."
  }
}
```

Use the stable `code` for program logic. Show `message` to a person, and follow `resolution` when an agent can recover.

## Desktop Chrome browser control

`GET /api/me/browser` reports the browser owner, extension version, paired state and online state. There is no backend selector. `PATCH /api/me/browser` is retired: authenticated requests receive JSON 404. `POST /api/me/browser/pair` creates a five-minute code; `replace: true` permits replacement. `DELETE /api/me/browser` revokes pairing. `GET /api/me/browser/extension.zip` downloads the extension. The retained routes use the authenticated member's `user:self` capability; agent tokens cannot use them.

Interactive agent actions use `POST /api/agents/:id/browser` and require the manager's paired Desktop Chrome with a tab explicitly offered to All eligible agents or that agent in the extension popup. Actions use that tab and ignore viewport settings. `close` detaches, leaving tabs open. A lost action can have an unknown outcome and is never replayed. `preview-url` remains a separate server-side screenshot path for public HTTP(S) sites and office-hosted pages. See [installation](self-hosted.md#desktop-chrome-extension).

`{"action":"tabs"}` returns `tabs:[{target,scope,title,url}]` for accessible established offers only. `scope` is `{"kind":"all"}` or `{"kind":"agent","agentId":"..."}`. Titles and URLs are cached display hints from offer or popup admission, not live page reads. Discovery does not wait for a busy tab and never enumerates unrelated Chrome tabs. Every page action accepts optional `target`, an opaque handle valid for that offer and connection. For example: `{"action":"snapshot","target":"<target from tabs>"}`. Without it, the agent's individual offer takes precedence, otherwise the sole accessible All offer is used. Several All offers return `browser_target_required` without dispatch; list and select a target. Selection is not sticky. Revoked or inaccessible handles return `browser_control_ended`. `close` on an All target ends its grant for every caller.
