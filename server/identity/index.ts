// Identity & capabilities - the stable type / capability / auth-helper surface
// for contract enforcement. See internal-docs/generic-runtime-refactor.md →
// "Identities and capabilities".
//
// This module is a LEAF: it imports only shared types and the standard library.
// It does NOT import auth-middleware, the managers, or the token store
// (server/identity/tokens.ts imports FROM here, never the reverse), so the
// capability/type surface stays free of cycles and side effects.
//
import type { UserRole } from "../../shared/types.ts";

// A token (or cookie) resolves to one of four identity scopes. Scope is
// orthogonal to role: a USER identity additionally carries owner/member, which
// guards consult; AGENT, CRON-RUN and APP identities are non-user and never
// gate on role (see Identity.role).
//
// APP is the odd one out and deliberately so: it is the scope of a registered
// app's own server process (server/app-tokens.ts), which is agent-AUTHORED code
// running unattended. It acts with its owner agent's reach (ownerAgentId) but is
// never that agent, so every write records the app. Adding it here rather than
// off to one side is what makes every `switch (identity.scope)` in the guard
// catalog fail to compile until it has decided about apps.
export type TokenScope = "user" | "agent" | "cron-run" | "app" | "api";

// The capability lattice. A capability gates a class of operations; the route
// table's `requiredCapability` is checked against the identity's set before any
// handler runs. The set grows additively (capability-lattice expansion is a
// follow-up); do not repurpose an existing capability's meaning.
export type Capability =
  | "audit:read"
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
  | "user:env"
  // Change the variables, secrets and MCP servers, with their notes, and read
  // their lists, names and Test results: never a value. Held by USER, API and
  // the PRIVILEGED agent set (Nil, 2026-10-14); absent from the AGENT baseline,
  // RUN and APP. The value reads stay with user:env and secret:show, which no
  // agent set holds. Its guards give each caller its user's reach: the user's
  // own items, and the office's and every member's when the user is an owner.
  | "integration:manage"
  | "user:admin"
  // users.create through an office owner's proxy: a privileged agent or an API
  // token. Held by the PRIVILEGED agent and API sets only. A human creates
  // members through user:admin. The route guard limits a proxy to a member
  // (room grants allowed), and only while its user is an office owner.
  | "user:create"
  | "user:prompt"
  | "office:admin"
  // Read and change the office prompt, the office name, the member usage cap
  // switch and the members' share of the weekly limit (office.getSettings and
  // office.setSettings). Held by USER, API and the PRIVILEGED agent set (Nil,
  // 2026-10-14); absent from the AGENT baseline, RUN and APP. Its guard admits
  // an owner, or a token or agent whose user is an office owner. office:admin
  // keeps the other owner routes (access, update, storage).
  | "office:settings"
  | "invite:manage"
  // Show a saved secret's value: the member's own, or an office one for an
  // owner. Held by USER and API only; no agent, run or app set holds it, so
  // the value never reaches an agent token (Nil, 2026-10-13).
  | "secret:show"
  | "session:manage"
  | "cron:read"
  | "cron:manage"
  // Read, change, delete and run only the schedules this agent made, within
  // its own mode and folder (server/cron-agent-limits.ts). The AGENT baseline;
  // cron:manage, where held, is the wider right and wins.
  | "cron:own"
  | "editor:use"
  | "file:upload"
  | "terminal:use"
  // Shared by USER and AGENT - the global task board.
  | "task:read"
  | "task:write"
  // Shared by USER and AGENT - isomux-memory (durable shared facts).
  | "memory:read"
  | "memory:write"
  // The pager. pager:raise is held by AGENT and APP: a page's source and
  // target come from the raising token, so a human or an API token has nothing
  // to raise as. An app also resolves its own pages with it. Reading, acking
  // and resolving follow room access for humans and agents alike, the same as
  // the task board, and an app page is also open to the app owner and office
  // owners.
  | "pager:raise"
  | "pager:read"
  | "pager:write"
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
  // APP-identity only, and in NO static set: appIdentityFromToken adds it
  // while the app has a live owner agent AND its owner turned on the app's
  // inbox access. It reaches the owner's asks (GET /api/asks and the
  // answers) and the read files of those asks, never a secret request.
  | "app:inbox"
  // Shared by USER, AGENT and API - the webhook registry. Like app:read and
  // app:write, a BASELINE agent capability; the webhookOwnerOrOfficeOwner
  // guard scopes it to the caller's own hooks. CRON-RUN and APP do not hold
  // it: a run has nobody to hand a hook URL to.
  | "webhook:read"
  | "webhook:write"
  // The members chat on the Lobby tab: humans and their proxies only. Held by
  // USER, API and the PRIVILEGED agent set; deliberately absent from the AGENT
  // baseline, RUN and APP sets, so an ordinary agent, a cron run or an app can
  // neither read nor write it (Nil, 2026-09-05).
  | "chat:members"
  // Shared by USER and AGENT - reading conversation logs (history search and
  // session retrieval, GET /api/agents/:id/logs). DELIBERATELY NOT office:read:
  // an ordinary agent token does not carry office:read, and widening that
  // capability to reach this route would drag every other office:read surface
  // along with it. Its own capability is what keeps the widening surgical.
  | "log:read"
  // Voice through OpenAI (voice.status, voice.transcribe, voice.speak): each
  // call spends the caller's user's voice key (server/voice-key.ts). Held by
  // USER, API and the AGENT baseline (so the PRIVILEGED set too). An app with
  // a live owner agent inherits it (appCapabilities); that guards nothing the
  // owner lacks, since the agent's own env already holds the key. RUN and
  // plain APP do not hold it.
  | "voice:use"
  // Non-user sender/affordance capabilities. Deliberately absent from USER
  // scope: a human is not an agent or cron run and has no own-chat.
  | "agent:send-as-self"
  // CRON-RUN only: send a message attributed to the live scheduled job. Kept
  // distinct from agent:send-as-self because a run is never an agent.
  | "agent:send-as-cron"
  // Durable personal API-token scope. Separate discovery and send capabilities
  // keep the credential from inheriting any broader browser surface.
  | "api:discover-agents"
  | "api:send-message"
  | "agent:send-to-api-token"
  | "api:drain-inbox"
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
  // On APP scope this field is TRUTHFUL: the app owner, who is also the owner
  // agent's manager whenever ownerAgentId is set. Room access keys on it, so an
  // app with an owner reaches that agent's rooms; without one, every guard
  // that owner-matches on userId refuses the app first.
  userId: string | null;
  // Present only on the corresponding scope.
  agentId?: string;
  cronjobId?: string;
  runId?: string;
  // APP scope: the registered app's name (unique, and fixed for its whole life).
  appName?: string;
  // APP scope: the live owner agent whose reach the app has, read on each
  // request (appIdentityFromToken). Absent when the owner is gone, so the app
  // has only APP_CAPABILITIES. A REACH fact only: no attribution path reads it,
  // and agentId stays unset, so no guard can mistake the app for its owner.
  ownerAgentId?: string;
  // API scope: stable token id for idempotency and a server-stored display name
  // used in sender attribution. Neither comes from the request body.
  apiTokenId?: string;
  apiTokenName?: string;
  // Role is authoritative for USER scope. API scope also carries the issuing
  // user's truthful, live role, although no API guard currently consults it.
  // For AGENT, CRON-RUN, and APP scope it is an inert least-privilege filler
  // ("member"). Authorization for those identities MUST key on scope +
  // capabilities + resource guards, never on
  // role - a role-only guard must never authorize an agent/run identity.
  role: UserRole;
  capabilities: readonly Capability[];
}

// USER (browser) set: every capability except the two agent-identity ones,
// app:message (a person messages an agent by typing in its chat) and
// user:create (an owner creates members through user:admin). `log:read`
// also covers read-only context and subscription checks for reachable agents.
// Owner vs member is NOT expressed here - both humans hold this full set and
// owner-only routes are blocked for members by the officeOwner guard, not by a
// missing capability.
export const USER_CAPABILITIES: readonly Capability[] = [
  "audit:read",
  "office:read",
  "chat:members",
  "agent:manage",
  "agent:converse",
  "agent:privilege",
  "room:manage",
  "view:manage",
  "user:self",
  "user:env",
  "integration:manage",
  "user:admin",
  "office:admin",
  "office:settings",
  "invite:manage",
  "secret:show",
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
  "pager:read",
  "pager:write",
  "webhook:read",
  "webhook:write",
  "voice:use",
];

// AGENT set: the loopback surface plus the global task board, isomux-memory,
// and the app registry. An agent can message as itself, use the task board and
// shared memory, register and manage its user's apps, read conversation logs
// and usage checks it can reach, and use the self-affordances on its own chat.
// It reaches only the schedules it made itself (cron:own). It cannot
// spawn/kill, touch settings or mint invites - those capabilities are simply
// absent.
export const AGENT_CAPABILITIES: readonly Capability[] = [
  "agent:send-as-self",
  "agent:send-to-api-token",
  "task:read",
  "task:write",
  "memory:read",
  "memory:write",
  "log:read",
  "app:read",
  "app:write",
  "webhook:read",
  "webhook:write",
  "cron:own",
  "self:affordance",
  "pager:raise",
  "pager:read",
  "pager:write",
  "voice:use",
];

// PRIVILEGED AGENT set: the baseline AGENT set PLUS a curated allowlist of the
// spawning user's operator capabilities. A privileged agent's token carries
// this so it can drive other agents' sessions the way its user can from the UI
// (resume / listSessions / sendNow / newConversation / cancelQueued / lifecycle
// / editor / uploads), fully manage cron over its OWN jobs (cron:read +
// cron:manage; the cronjobOwnerOrOfficeOwner guard additionally owner-matches a
// privileged agent - see guards.ts), and manage rooms it can access (room:manage:
// create / rename / settings / close; create is office-wide, the rest are
// room-access-scoped on its spawning user's id).
//
// This is a CURATED allowlist, NOT union(AGENT, USER): the literal union exposes
// capability-only owner routes - invites.mintSelf (mints a durable owner LOGIN),
// sessions.revoke (kills the human's browser session). So invite:manage,
// secret:show (a saved secret's value), session:manage, user:self and
// user:admin (user records / access),
// office:admin (office access, update and storage), view:manage, terminal:use, and
// agent:privilege (the toggle itself) are DELIBERATELY excluded. Scope stays
// "agent" regardless, so every scope==="user" guard (officeOwner/selfUser/the
// messageSend user-path) still blocks a privileged agent - those exclusions are
// defense-in-depth on top of that. Whenever a new capability is added, decide
// explicitly whether a privileged agent should hold it; do NOT let it ride in by
// default. The exclusions bind the agent token only: in a Chrome tab that its
// manager offered on the office, an agent acts with the manager's browser
// session (docs/security-audit.md section 6.5).
// user:prompt grants only member-instructions reads and writes through its
// guards.
// integration:manage changes its manager's variables, secrets and MCP servers
// (and the office's and other members' while the manager is an owner); user:env
// and secret:show stay out, so no value comes back.
// office:settings reaches only the office settings and instructions routes, and
// only while the manager is an office owner; office:admin stays out.
// user:create reaches member creation: it reaches only users.create,
// whose guard allows a member (room grants allowed), and only while the
// spawning user is an office owner. It mints no sign-in link.
// agent:send-as-cron is deliberately absent too: cron attribution belongs only
// to a live CRON-RUN identity, never to an agent with operator privileges.
export const PRIVILEGED_AGENT_CAPABILITIES: readonly Capability[] = [
  ...AGENT_CAPABILITIES,
  "audit:read",
  "agent:converse",
  "office:read",
  "chat:members",
  "agent:manage",
  "room:manage",
  "editor:use",
  "file:upload",
  "cron:read",
  "cron:manage",
  "user:create",
  "user:prompt",
  "integration:manage",
  "office:settings",
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
// `log:read` is DELIBERATELY absent. A run has no chat and no history of its
// own to reconnect to, so it does not read agent logs.
//
// A run acts for its job's creator the way an agent acts for its manager: its
// userId is the creator's, so a route that only a room-access guard gates
// (hasRoomAccess) gives the run its creator's rooms, on purpose.
//
// task:read + task:write are here because the cron system prompt gives a run the
// board, and it reached it over the (now retired) loopback /tasks route. The
// board a run sees is office-global plus its job's room, while the job's creator
// can access that room (boardRoomIdsForIdentity); a create with no roomId files
// in that room, else global.
//
// `app:read` / `app:write` are DELIBERATELY absent for the same reason as
// log:read. A run is a fresh session with no chat and nobody to hand a URL to;
// registering a long-lived service from an unattended job is not something
// anyone has asked for, and granting it later is one line.
export const RUN_CAPABILITIES: readonly Capability[] = [
  "self:affordance",
  "agent:send-as-cron",
  "task:read",
  "task:write",
];

// APP set: what an app has on its own - message its target (app:message) and
// raise and resolve its own pages (pager:raise). With a live owner agent the app
// also has that agent's set (appCapabilities), so an app token is as sensitive
// as its owner agent's token. Without one, these two are all: a 403 for anything
// else (I know who you are, you may not do that), not a 401. The whole-table
// parity test in routes-table.test.ts pins both cases.
export const APP_CAPABILITIES: readonly Capability[] = [
  "app:message",
  "pager:raise",
];

// Never passed from an owner agent to its app. The self ones act as the agent
// in its own chat, outbox or token, which an app does not have; chat:members
// would post with no app author shape; secret:show is in no agent set, and is
// named so that a later set that gains it does not hand it to apps.
export const APP_NEVER_INHERITED: readonly Capability[] = [
  "self:affordance",
  "agent:send-as-self",
  "agent:send-to-api-token",
  "chat:members",
  "secret:show",
];

// An app's set when its owner agent holds ownerSet: the owner's set minus
// APP_NEVER_INHERITED, plus the app's own two.
export function appCapabilities(
  ownerSet: readonly Capability[],
): readonly Capability[] {
  return [
    ...new Set([
      ...ownerSet.filter((cap) => !APP_NEVER_INHERITED.includes(cap)),
      ...APP_CAPABILITIES,
    ]),
  ];
}

// API set: a remote member gets the same curated operational reach as a
// privileged agent, expressed explicitly so every capability is an audit
// decision. Identity and durable-access surfaces stay excluded: invite:manage,
// session:manage, user:self, user:admin, office:admin, view:manage and
// agent:privilege. user:env is the explicit exception for the issuing user's
// managed environment routes: their own values, and - when that user is an
// office owner - every member's variables, secrets and MCP servers, with
// integration:manage for the writes. secret:show goes with it: a token shows its user's own secret values, and an
// owner's token the office ones. office:settings gives an owner's token the
// office prompt, name and member usage cap, as a privileged agent. user:prompt
// gives a token its user's special instructions, and an owner's token every
// member's, as a privileged agent. user:create
// is the other exception, with the privileged agent's member-only limits. The
// agent/cron/app sender and self-affordance capabilities are also absent: an API
// token is its issuing user, not an office participant. Its `log:read` covers
// conversation logs plus context and subscription checks. These exclusions are
// defense in depth, not a shell boundary - agent:manage can spawn an agent that
// runs commands. Decide every future capability here; never spread another set.
export const API_CAPABILITIES: readonly Capability[] = [
  "audit:read",
  "user:env",
  "integration:manage",
  "office:settings",
  "user:prompt",
  "secret:show",
  "api:discover-agents",
  "api:send-message",
  "api:drain-inbox",
  "office:read",
  "chat:members",
  "agent:manage",
  "agent:converse",
  "room:manage",
  "editor:use",
  "file:upload",
  "cron:read",
  "cron:manage",
  "user:create",
  "task:read",
  "task:write",
  "memory:read",
  "memory:write",
  "log:read",
  "app:read",
  "app:write",
  "pager:read",
  "pager:write",
  "webhook:read",
  "webhook:write",
  "voice:use",
];

// An agent, or an app acting with its live owner agent's reach (ownerAgentId,
// set by appIdentityFromToken only while that agent is live and shares the app
// owner as manager). EVERY reach check that admits agents goes through this, so
// an app with an owner gets the agent's reach and an app without one gets none
// of it. Self-bound checks never use it: they compare identity.agentId, which an
// app does not carry, so an app is never its owner agent.
export function actsForAgent(identity: Identity): boolean {
  if (identity.scope === "agent") return true;
  return (
    identity.scope === "app" &&
    typeof identity.ownerAgentId === "string" &&
    identity.ownerAgentId.length > 0
  );
}

// An ordinary agent, or an app of one: it holds cron:own but not cron:manage,
// so it reaches only the schedules its agent made.
export function cronOwnOnly(identity: Identity): boolean {
  return (
    actsForAgent(identity) &&
    identityHasCapability(identity, "cron:own") &&
    !identityHasCapability(identity, "cron:manage")
  );
}

// The agent whose live reach the caller has: the agent itself, or an app's
// owner agent. For REACH questions only (is that agent privileged); never for
// attribution.
export function reachAgentId(identity: Identity): string | null {
  if (identity.scope === "agent") return identity.agentId || null;
  return actsForAgent(identity) ? identity.ownerAgentId! : null;
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
