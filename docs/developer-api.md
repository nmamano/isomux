---
title: Isomux developer API resources
description: Machine-readable API, authentication, and error references for Isomux developers and agents.
order: 7
navTitle: Developer API
---

# Isomux developer API resources

The [Isomux OpenAPI specification](/openapi.json) describes the public API on isomux.com. The website currently exposes one endpoint, `POST /api/chat`, which streams answers about Isomux as server-sent events.

Self-hosted and hosted Isomux offices also expose a room-scoped REST API for agents and signed-in users. Each office injects exact API instructions and its bearer token into its agents. Browser clients use the office session cookie. Start with [access and invites](/docs/access-and-invites) for the authentication model and the [GitHub route table](https://github.com/nmamano/isomux/blob/main/server/routes/table.ts) for the current source-level contract.

## Message an agent from another device

One token = one inbox = one conversation. The token talks to any number of agents; everything it sends and everything it receives lives in one append-only log for that token, in order, each entry with an increasing sequence number.

In **Settings → You → API tokens**, create a named token with a 30-day expiry, a 365-day expiry, or no expiry. Copy the raw token when it appears; Isomux does not show it again. Set your office URL and paste the token into your shell:

```bash
OFFICE_URL="https://office.example.com"
TOKEN="paste-the-token-shown-once"

curl -s "$OFFICE_URL/agents" \
  -H "Authorization: Bearer $TOKEN"
```

The response lists the live agents in rooms you can access, plus the receptionist. The same manifest is available at `GET /api/agents`. An ordinary agent has a 1-based `room` number. The receptionist has `room: null`, `roomName: "Lobby"` and `roomId: "lobby"`. Copy the target agent's `id`, and then send the message:

```bash
AGENT_ID="agent-123"

curl -s -X POST "$OFFICE_URL/api/agents/$AGENT_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Please check the latest alert."}'
```

The send response contains `messageId`, which is also the `id` of the send entry in the token log.

For example, the agent sees a message as `[Boss (API token "Phone 'alerts" (pat-123))]`. If the target agent is waiting for a permission answer, the next API-token message to that agent is used as the answer instead of a new chat message. A token has the issuing user's operational reach: agents and their conversations, rooms, tasks, apps, logs, schedules, editor and file actions, memory, and office reads. It cannot mint durable access, revoke browser sessions, change user access or office settings, or grant the privileged-agent flag. These exclusions are defense in depth: a token can spawn an agent that runs commands. Room access and the issuing user's current role are checked on every request. An expired or revoked token stops working immediately.

## Members chat

Users, their API tokens and privileged agents can read and post to the office-wide members chat. Ordinary agents, scheduled runs and apps have no `chat:members` capability.

- `GET /api/members-chat?before=<message-id>&limit=100` returns `messages`, `hasMore`, `readPointer` and `unread`. Messages are in chronological order.
- `POST /api/members-chat` accepts `{"text":"..."}` and optional uploaded `attachments`. The server derives the author from the caller's identity.
- `PATCH /api/members-chat/:id` accepts `{"text":"..."}` and edits the caller's own post.
- `DELETE /api/members-chat/:id` deletes the caller's own post, or any post when the caller acts for an office owner.
- `POST /api/members-chat/read` accepts `{"lastReadId":"..."}` and updates that user's read pointer.
- `POST /api/members-chat/uploads` accepts multipart files; `GET /api/members-chat/files/:filename` reads an uploaded file under the same capability gate.

A user and their proxies share post ownership and a read pointer. Message and delete events reach all browser sessions; read-pointer events reach only that user's sessions. Month files, read pointers and attachments live under `members-chat/` in the state root. The storage report counts them under **Other state**; storage pruning does not delete them.

## Receive replies from office agents

The incoming message label gives the agent the API token id it needs to reply:

```bash
curl -s -X POST "$OFFICE_URL/api/api-token-inboxes/$TOKEN_ID/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"The report is ready."}'
```

The send succeeds without a poller. Its response includes `messageId` and `lastDrainedAt`, or `null` for `lastDrainedAt` when the token has never read its log.

Connect to the office’s existing `/ws` WebSocket with an `Authorization: Bearer <token>` header. Use `wss://` for an HTTPS office. The server accepts no token in the URL. This requires a client that can set handshake headers; the browser WebSocket API cannot.

The socket is receive-only. Send messages through REST. Each new send or reply produces one event:

```json
{"type":"api_token_log_entry","tokenId":"pat-123","entry":{"sequence":124,"id":"message-123","text":"The report is ready.","direction":"from_agent","senderAgentId":"agent-123","senderAgentName":"Worker","senderRoomName":"Isomux","sentAt":1788810481060}}
```

`entry` is the same object returned by the cursor read below. The socket receives only entries for its authenticated token, including when the owner has other tokens. It receives no browser state, general office activity, or other tokens’ entries. Client frames are ignored. An invalid bearer fails authentication even if the request also has a valid browser cookie. Revocation closes connected sockets; the server also checks token expiry and owner existence before each delivery.

A connection gives no replay. Connect first and buffer live events, read from the last saved cursor until the cursor read reaches `latestSequence`, and then merge the buffered entries in sequence order and remove duplicates by `sequence`. Save the cursor after processing each entry. Repeat this process after a disconnect. The cursor read is also available to clients that use polling:


```bash
curl -s -X POST "$OFFICE_URL/api/me/api-token-inbox/drain" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"after":123}'
```

`after` is the last sequence the client has saved and processed; it defaults to 0 and must be a nonnegative safe integer. The response contains `entries`, `firstSequence`, `latestSequence`, `previouslyDrainedAt`, and `drainedAt`. Each read returns up to 500 entries with `sequence > after`, in sequence order. The client reads again from the last sequence it received until it reaches `latestSequence`. A cursor at or beyond `latestSequence` returns an empty `entries` array.

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
returns 422. If a scope is full, trim your own lines, propose the rest to a boss,
or drop the note; do not move it to a wider scope. Do not make big changes to
office memory.

`PUT /api/memory` accepts `{ scope, scopeId?, text, version }` and replaces the
raw file. Use the version from GET. A stale version returns 409. REPLACE is the
curation path and does not apply the 400-character APPEND limit.

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
