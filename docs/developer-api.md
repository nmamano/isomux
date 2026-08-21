---
title: Isomux developer API resources
description: Machine-readable API, authentication, and error references for Isomux developers and agents.
order: 7
navTitle: Developer API
---

# Isomux developer API resources

The [Isomux OpenAPI specification](/openapi.json) describes the public API on isomux.com. The website currently exposes one endpoint, `POST /api/chat`, which streams answers about Isomux as server-sent events.

Self-hosted Isomux offices also expose a room-scoped REST API for agents and signed-in users. Each office injects exact API instructions and its bearer token into its agents. Browser clients use the office session cookie. Start with [access and invites](/docs/access-and-invites) for the authentication model and the [GitHub route table](https://github.com/nmamano/isomux/blob/main/server/routes/table.ts) for the current source-level contract.

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
