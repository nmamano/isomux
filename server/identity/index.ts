// Identity & capabilities - the stable type / capability / auth-helper surface
// for the Phase 2 contract-enforcement foundation. See
// internal-docs/generic-runtime-refactor.md → "Identities and capabilities".
//
// This module is a LEAF: it imports only shared types and the standard library.
// It does NOT import auth-middleware, the managers, or the token store
// (server/identity/tokens.ts imports FROM here, never the reverse), so the
// capability/type surface stays free of cycles and side effects.
//
// Phase 2.1 is ADDITIVE: this defines the identity model and stateless helpers
// so the dispatcher (2.2/2.3) can authorize against it later. Nothing here
// enforces anything yet.

import type { UserRole } from "../../shared/types.ts";

// A token (or cookie) resolves to one of four identity scopes. Scope is
// orthogonal to role: a USER identity additionally carries owner/member, which
// guards consult; AGENT, CRON-RUN and APP identities are non-user and never
// gate on role (see Identity.role).
//
// APP is the odd one out and deliberately so: it is the scope of a registered
// app's own server process (server/app-tokens.ts), which is agent-AUTHORED code
// running unattended, and it holds NO capabilities at all today. Adding it here
// rather than off to one side is what makes every `switch (identity.scope)` in
// the guard catalog fail to compile until it has decided about apps.
export type TokenScope = "user" | "agent" | "cron-run" | "app";

// The capability lattice. A capability gates a class of operations; the route
// table's `requiredCapability` is checked against the identity's set before any
// handler runs. The set grows additively (capability-lattice expansion is a
// follow-up); do not repurpose an existing capability's meaning.
export type Capability =
  // USER (browser) capabilities - held by any human identity (owner or member),
  // narrowed further by resource guards (officeOwner, selfOrOwner, …).
  | "office:read"
  | "agent:manage"
  | "agent:converse"
  // Grant/revoke an agent's `privileged` flag. USER-only and deliberately
  // ABSENT from both AGENT and the privileged-agent set, so it is the stage-1
  // half of the double-gate on agents.setPrivileged: no agent - privileged or
  // not - can ever flip the flag (stage 2 additionally requires scope==="user").
  | "agent:privilege"
  | "room:manage"
  | "view:manage"
  | "user:self"
  | "user:admin"
  | "office:admin"
  | "invite:manage"
  | "session:manage"
  | "cron:read"
  | "cron:manage"
  | "editor:use"
  | "file:upload"
  | "terminal:use"
  // Shared by USER and AGENT - the global task board.
  | "task:read"
  | "task:write"
  // Shared by USER and AGENT - isomux-memory (durable shared facts).
  | "memory:read"
  | "memory:write"
  // Shared by USER and AGENT - the app registry. BASELINE for an ordinary
  // agent, not a privileged extra: an agent registering the app it just built
  // is the entire feature. Object-level scoping (your own apps; an office owner
  // sees all) is the appOwnerOrOfficeOwner guard's job, not the capability's.
  | "app:read"
  | "app:write"
  // APP-identity only, and the ONLY capability an app token holds: a registered
  // app messaging the agent that built it. Deliberately absent from USER and
  // AGENT - a human has the chat box and an agent has agents.sendMessage, so
  // granting it anywhere else would only widen what a stolen token reaches.
  | "app:message"
  // Shared by USER and AGENT - reading conversation logs (history search and
  // session retrieval, GET /api/agents/:id/logs). DELIBERATELY NOT office:read:
  // an ordinary agent token does not carry office:read, and widening that
  // capability to reach this route would drag every other office:read surface
  // along with it. Its own capability is what keeps the widening surgical.
  | "log:read"
  // AGENT-identity capabilities - deliberately absent from USER scope (a human
  // is not an agent and has no own-chat).
  | "agent:send-as-self"
  | "self:affordance";

// A resolved caller identity. Produced from a cookie session
// (identityFromSession) or a bearer token (resolveToken in ./tokens.ts).
export interface Identity {
  scope: TokenScope;
  // The owning/acting user. For USER scope this is the human; for AGENT scope
  // the spawning user (drives token-derived attribution); for CRON-RUN scope
  // the cronjob's creator (may be null for an unowned job); for APP scope the
  // user the app belongs to.
  //
  // On APP scope this field is TRUTHFUL, not an authority: an app is not its
  // owner. Every guard that owner-matches on userId is scope-gated first, and
  // the whole-table reachability test pins that an app identity authorizes
  // nothing - carrying null here instead would make attribution dishonest and
  // hide a missed scope check rather than prevent one.
  userId: string | null;
  // Present only on the corresponding scope.
  agentId?: string;
  cronjobId?: string;
  runId?: string;
  // APP scope: the registered app's name (unique, and fixed for its whole life).
  appName?: string;
  // Role is meaningful ONLY for USER scope (owner-only routes are gated by the
  // officeOwner guard on a USER identity). For AGENT and CRON-RUN scope it is
  // an inert least-privilege filler ("member"). Authorization for non-user
  // identities MUST key on scope + capabilities + resource guards, never on
  // role - a role-only guard must never authorize an agent/run identity.
  role: UserRole;
  capabilities: readonly Capability[];
}

// USER (browser) set: every capability except the two agent-identity ones and
// app:message (a person messages an agent by typing in its chat).
// Owner vs member is NOT expressed here - both humans hold this full set and
// owner-only routes are blocked for members by the officeOwner guard, not by a
// missing capability.
export const USER_CAPABILITIES: readonly Capability[] = [
  "office:read",
  "agent:manage",
  "agent:converse",
  "agent:privilege",
  "room:manage",
  "view:manage",
  "user:self",
  "user:admin",
  "office:admin",
  "invite:manage",
  "session:manage",
  "cron:read",
  "cron:manage",
  "editor:use",
  "file:upload",
  "terminal:use",
  "task:read",
  "task:write",
  "memory:read",
  "memory:write",
  "log:read",
  "app:read",
  "app:write",
];

// AGENT set: the loopback surface plus the global task board, isomux-memory,
// and the app registry. An agent can message as itself, use the task board and
// shared memory, register and manage its user's apps, read conversation logs it
// can reach, and use the self-affordances on its own chat. It cannot spawn/kill,
// touch settings, mint invites, mutate cronjobs, or read cronjob transcripts -
// those capabilities are simply absent.
export const AGENT_CAPABILITIES: readonly Capability[] = [
  "agent:send-as-self",
  "task:read",
  "task:write",
  "memory:read",
  "memory:write",
  "log:read",
  "app:read",
  "app:write",
  "self:affordance",
];

// PRIVILEGED AGENT set: the baseline AGENT set PLUS a curated allowlist of the
// spawning user's operator capabilities. A privileged agent's token carries
// this so it can drive other agents' sessions the way its user can from the UI
// (resume / listSessions / sendNow / newConversation / cancelQueued / lifecycle
// / editor / uploads), fully manage cron over its OWN jobs (cron:read +
// cron:manage; the cronjobOwnerOrOfficeOwner guard additionally owner-matches a
// privileged agent - see guards.ts), and manage rooms it can access (room:manage:
// create / rename / settings / close, Nil-approved expansion; create is
// office-wide, the rest are room-access-scoped on its spawning user's id).
//
// This is a CURATED allowlist, NOT union(AGENT, USER): the audit (task 98d63ef7)
// found the literal union exposes capability-only owner routes - invites.mintSelf
// (mints a durable owner LOGIN), sessions.revoke (kills the human's browser
// session). So invite:manage, session:manage, user:* (user records / access),
// office:admin (office settings + access), view:manage, terminal:use, and
// agent:privilege (the toggle itself) are DELIBERATELY excluded. Scope stays
// "agent" regardless, so every scope==="user" guard (officeOwner/selfUser/the
// messageSend user-path) still blocks a privileged agent - those exclusions are
// defense-in-depth on top of that. Whenever a new capability is added, decide
// explicitly whether a privileged agent should hold it; do NOT let it ride in by
// default.
export const PRIVILEGED_AGENT_CAPABILITIES: readonly Capability[] = [
  ...AGENT_CAPABILITIES,
  "agent:converse",
  "office:read",
  "agent:manage",
  "room:manage",
  "editor:use",
  "file:upload",
  "cron:read",
  "cron:manage",
];

// The capability set an AGENT-scope token resolves to, by its privileged flag.
// The ONE place that maps the persisted/minted flag to a capability set, so the
// token store (resolveToken) and any future caller agree.
export function agentCapabilities(privileged: boolean): readonly Capability[] {
  return privileged ? PRIVILEGED_AGENT_CAPABILITIES : AGENT_CAPABILITIES;
}

// CRON-RUN set: the self-affordances, bound to its {cronjobId, runId}, plus the
// task board. The cron-run analogue of an agent token; closes the loopback hole
// for a firing run's in-flight read-file/diff without relying on a bypass.
//
// `log:read` is DELIBERATELY absent. A run has no room, no chat, and no history
// to reconnect itself to; its room-access set is empty by rule
// (accessibleRoomIdsForIdentity), so the capability would reach nothing anyway -
// but leaving it out states the intent instead of relying on that coincidence.
//
// task:read + task:write are here because the cron system prompt gives a run the
// board, and it reached it over the (now retired) loopback /tasks route. The
// board a run sees is office-GLOBAL only: accessibleRoomIdsForIdentity returns
// the empty set for cron-run scope, and a create with no roomId files global.
//
// `app:read` / `app:write` are DELIBERATELY absent for the same reason as
// log:read. A run is a fresh session with no chat and nobody to hand a URL to;
// registering a long-lived service from an unattended job is not something
// anyone has asked for, and granting it later is one line.
export const RUN_CAPABILITIES: readonly Capability[] = [
  "self:affordance",
  "task:read",
  "task:write",
];

// APP set: ONE capability, and the narrowness is the whole point of the scope.
//
// An app may message the agent that built it. That is the entire surface: it
// cannot read the office, list its siblings, touch the task board or shared
// memory, or manage even ITS OWN registry record - app:read and app:write are
// the owner's capabilities, not the app's, so an app cannot rename, restart or
// delete itself, nor read another app's port. The route this one capability
// reaches carries no recipient parameter either (the registry decides who hears
// it), so the widest thing a stolen app token can do is wake one agent, rate-
// limited, with a message labelled as coming from an app.
//
// A single-entry set rather than no scope at all because the token must still be
// distinguishable from a garbage one - an app presenting its token for anything
// else gets a 403 (I know who you are, you may not do that), not a 401. The
// whole-table reachability test in routes-table.test.ts walks every route and
// pins that the one is exactly one.
export const APP_CAPABILITIES: readonly Capability[] = ["app:message"];

export function capabilitiesForScope(scope: TokenScope): readonly Capability[] {
  switch (scope) {
    case "user":
      return USER_CAPABILITIES;
    case "agent":
      return AGENT_CAPABILITIES;
    case "cron-run":
      return RUN_CAPABILITIES;
    case "app":
      return APP_CAPABILITIES;
  }
}

export function identityHasCapability(
  identity: Identity,
  cap: Capability,
): boolean {
  return identity.capabilities.includes(cap);
}

// Minimal shape needed to mint a USER identity from a validated cookie session.
// Kept narrow (not the full SessionLookup) so this module stays decoupled from
// server/auth.ts.
export interface UserSessionIdentity {
  userId: string;
  role: UserRole;
}

// Bridge a validated cookie session to the unified Identity model. The cookie
// path remains the user-auth path in 2.1 (no user bearer tokens are minted);
// this is what lets the dispatcher treat cookie and token callers uniformly.
export function identityFromSession(lookup: UserSessionIdentity): Identity {
  return {
    scope: "user",
    userId: lookup.userId,
    role: lookup.role,
    capabilities: USER_CAPABILITIES,
  };
}

// Parse `Authorization: Bearer <token>`. Case-insensitive scheme, trimmed
// token, single scheme only. Returns null for missing / empty / non-bearer /
// scheme-only headers. Never logs the raw value.
export function readBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}
