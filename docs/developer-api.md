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

The response includes `queued`, which is `true` when the message is waiting behind an active turn or `false` when the office handed it to a turn. When `queued` is `true`, `messageId` is non-empty and identifies the queued message; the issuing human can cancel it from the office while it remains queued. An immediate delivery has no cancellation handle, so `queued` is `false` and `messageId` is an empty string.

The agent sees the message as `[Your name (API token "Token name")]`. If the target agent is waiting for a permission answer, the next API-token message to that agent is used as the answer instead of a new chat message. The token cannot list killed agents, read conversations or files, upload files, open a WebSocket, manage the office, or use any API route except live-agent discovery and messaging. Room access and the issuing user's current role are checked on every request. An expired or revoked token stops working immediately.

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
