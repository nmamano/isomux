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

In **User Settings → API tokens**, create a named token with a 30-day expiry, a 365-day expiry, or no expiry. Copy the raw token when it appears; Isomux does not show it again. Set your office URL and paste the token into your shell:

```bash
OFFICE_URL="https://office.example.com"
TOKEN="paste-the-token-shown-once"

curl -s "$OFFICE_URL/agents" \
  -H "Authorization: Bearer $TOKEN"
```

The response lists the live agents in rooms you can access. Copy the target agent's `id`, and then send the message:

```bash
AGENT_ID="agent-123"

curl -s -X POST "$OFFICE_URL/api/agents/$AGENT_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Please check the latest alert."}'
```

For example, the agent sees a message as `[Boss (API token "Phone 'alerts" (pat-123))]`. If the target agent is waiting for a permission answer, the next API-token message to that agent is used as the answer instead of a new chat message. A token has the issuing user's operational reach: agents and their conversations, rooms, tasks, apps, logs, cron jobs, editor and file actions, memory, and office reads. It cannot mint durable access, revoke browser sessions, change user access or office settings, or grant the privileged-agent flag. These exclusions are defense in depth: a token can spawn an agent that runs commands. Room access and the issuing user's current role are checked on every request. An expired or revoked token stops working immediately.

## Receive replies from office agents

The incoming message label gives the agent the API token id it needs to reply:

```bash
curl -s -X POST "$OFFICE_URL/api/api-token-inboxes/$TOKEN_ID/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"The report is ready."}'
```

The send succeeds without a poller. Its response includes `lastDrainedAt`, or `null` when the token has never drained its inbox. A full inbox returns `inbox_full`; the sender must wait for the remote boss to drain it.

The token drains its own inbox with a destructive poll:

```bash
curl -s -X POST "$OFFICE_URL/api/me/api-token-inbox/drain" \
  -H "Authorization: Bearer $TOKEN"
```

The response contains `messages`, `previouslyDrainedAt`, and `drainedAt`. A drain is at-most-once: it atomically removes the returned messages, so a response lost after the server commits cannot be recovered. Process and save each successful response before the next poll.

A send can reach the inbox before its sender echo is saved. If the send returns an error after delivery, a retry can create a duplicate.

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
