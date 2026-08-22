# App visibility and access

## Current model

An app belongs to the user who registered it, or to the manager of the agent
that registered it. The record stores that user's stable `userId`; agent-made
apps may also store `createdByAgentId`.

`GET /api/apps` returns every app to an office owner. Another user or their
agent gets only apps whose `userId` is theirs. App detail, logs, lifecycle,
update, and delete routes require the matching app capability and allow the
app's user, an office owner, or an agent whose manager owns the app. Ownerless
records appear only to office owners. All nine apps in the office where this
issue was reported have owners and creator-agent IDs as measured 2026-08-22.
Their eight distinct creator agents are live, and `game-video` belongs to Nil.

An app hostname has a separate auth boundary. A request without an app cookie
is sent to the office origin. Any signed-in office session can mint a code for
any live app label. Redemption creates an app cookie bound to that office
session and registration generation. Every HTTP request and WebSocket upgrade
revalidates that the office session exists, but does not test app ownership.
Thus any signed-in office user who knows an app URL can open it.

Marc does not own `game-video`, so the list hides it while its hostname accepts
his office session. A logged-out or private browser window cannot open it.
`game-video`'s creator is in Wall Game, which Marc can see as measured
2026-08-22. Under the proposed model, Marc gains list visibility and keeps URL
access. The reported mismatch closes by making the app discoverable to him.

Offices without app hostnames link directly to the allocated port. That traffic
does not pass through Isomux authentication. Its reachability depends on the
app's bind address and the host network.

## Proposed model

A user may discover and open an app when any of these is true:

- the user owns the app;
- the user is an office owner; or
- the app has a live `createdByAgentId`, and the user can see that agent under
  the existing room ACL.

An agent caller receives its manager's result from the same predicate. Its app
visibility follows its manager's room grants, not the room where the agent
itself sits. An app identity cannot list apps or inherit its owner's rooms; its
only app capability remains messaging its registering agent. App management
does not change: viewers cannot call app detail, logs, update, lifecycle, or
delete routes. Those remain behind `app:read` or `app:write` and the
app-owner-or-office-owner guard.

This supersedes the 2026-08-05 direction in
`internal-docs/agent-apps-design.md`. That document proposed room-derived
privacy but the shipped list used ownership and the hostname used the whole
office. The new rule makes the earlier room model precise: the live creator
agent supplies the room, and the existing user-room ACL supplies its audience.
It needs no second grant store or access editor. Office owners see every room,
so their app access follows from existing policy; app ownership remains an
independent fallback.

Ephemeral scratch shares remain a separate, room-scoped concept. Both surfaces
derive an audience from their agent, but scratch shares expire with the agent;
a registered app survives and falls back to its owner.

### Lifecycle

`createdByAgentId` is the durable link. It is set only from an authenticated
agent identity at registration, never from a request body. A direct human
registration has no creator agent. A pre-existing record without the field is
also treated as having no creator agent. Both cases are visible only to the app
owner and office owners.

The audience is derived at read and authorization time, not persisted:

- **Agent moved:** the old room audience loses access and the new room audience
  gains it as part of the move. Open app sockets for users who lost access are
  closed. One move can retarget several apps made by that agent.
- **Agent killed:** the creator is no longer live, so the app immediately falls
  back to its owner and office owners. A killed-agent history row does not grant
  access.
- **Agent revived:** revival under the same stable agent ID restores access from
  the room in which the agent is revived.
- **Room closed:** a live agent cannot remain in a closed room under current
  room-close rules. If state is inconsistent or the creator's room cannot be
  resolved, authorization fails closed to the app owner and office owners.
- **User deleted:** that identity and its agents can no longer authorize. If
  deletion kills its live agents, their apps fall back as above. A stale app
  owner ID grants nobody; office owners retain recovery access.

Every transition uses the same visibility predicate for list results,
`server/events/app-delta.ts` recipients, and hostname authorization. Agent move,
kill, revive, room close, and user deletion must emit app upserts/removals for
affected users rather than wait for the Apps-tab poll. Today app events run only
when an app record changes, so dependency-triggered events are a material new
implementation surface.

Move, kill, and revive need a narrower guard when the target agent created any
live registered app. Today, room co-members may perform all three operations on
another user's agent. Under this model that would let them retarget, remove, or
create an app audience without app authority, possibly for several apps at
once. For an agent with registered apps, allow these operations only to its
manager or an office owner; keep the current room-access guards for agents with
none. Revive resolves the killed agent's manager from its durable history, not
from its former room. The UI must explain the restriction before attempting the
operation.

These route guards now depend on the app registry: registering the agent's first
app narrows its lifecycle authority, and deleting its last app restores the
room-based guards. The dependency check and move, kill, or revive mutation run
synchronously without an await between them, so registration cannot race the
decision in the single Bun process. An unreadable registry fails closed to the
manager-or-office-owner rule.

### Hostname enforcement and revoke

The app mint route applies the predicate before issuing a code. Redemption
checks it again to cover an audience change between mint and redeem. Each later
HTTP request applies it from the revalidated office session.
`validateAppSession` must surface the stable user ID that `revalidateByHash`
already resolves rather than discard it as a boolean. Refusals do not reveal
whether an app exists.

WebSocket authorization runs only at upgrade today. Add an app-socket registry
keyed by registration and office session/user. Any lifecycle transition that
removes access closes affected open sockets; otherwise a game, terminal, or
dashboard could keep streaming indefinitely. App deletion and office-session
revocation use the same close path. Access loss therefore takes effect on HTTP
at the next request and on sockets immediately.

### API and UI

No grant API is needed because there is no app-specific access state. The
existing agent move, kill, and revive APIs are the complete write surface for
room-derived sharing, with the creator-app guard on all three routes, so agents
can perform the same actions as humans. The Apps tab shows only rows allowed by
the shared predicate and needs no app access editor.

Viewer rows expose only launch data: name, description, owner display name,
state, URL/port, `createdByAgentId`, and the creator agent's current display name
resolved from the live roster. The historical `createdBy` snapshot, command,
working and data directories, logs, and controls remain on owner-management
responses.

### Deployment boundary

The visibility model is identical for hosted and self-hosted offices: it
controls the Apps tab and registry reads even when no app-host domain exists.
Isomux also enforces it on app hostnames wherever configured. Direct-port links
cannot provide per-user access because they bypass Isomux. The standard
installer blocks app ports from the public network, while loopback, SSH tunnels,
tailnets, and custom firewall rules can make them reachable. The UI and docs
must say that room visibility governs discovery but does not authenticate direct
port traffic. Full visibility/access alignment requires app hostnames. Adding
authenticated port gateways would change app port and bind contracts and is a
separate migration.

## Settled product decisions

- App sharing follows the live creator agent's room visibility.
- Losing room visibility is intended to remove app access.
- Killed, missing, or unresolvable creator agents yield owner-plus-office-owner
  access; revival restores room-derived access.
- Existing and human-registered apps without a creator agent are
  owner-plus-office-owner only.
