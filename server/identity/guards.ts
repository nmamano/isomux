// Guard catalog - Phase 2.2. Named, individually contract-tested authorization
// policies. The dispatcher (./dispatch.ts) composes a route's coarse
// `requiredCapability` (stage 1) with one of these `resourceGuard`s (stage 2);
// no authorization logic lives in handler bodies. See
// internal-docs/generic-runtime-refactor.md → "Guard catalog",
// "Identities and capabilities", and Conventions → two-stage authz + error
// envelope.
//
// ADDITIVE (Phase 2.2): this catalog is built and contract-tested in ISOLATION.
// It is NOT wired into the live dispatchCommand switch or any HTTP handler, and
// it deletes no inline check. The strangler (Phase 3) is what routes live
// traffic through it.
//
// LEAF MODULE: imports only ./index.ts (Identity/Capability). It must NOT import
// server/isomux-office.ts, the managers, or users.ts - mutable office state reaches
// guards ONLY through the injected `GuardDeps` seam. That keeps the catalog pure
// and unit-testable, and let Phase 3b swap the access model (materialized
// `allowedRooms` → rule-based) by replacing the GuardDeps implementation, never
// a guard signature.

import { identityHasCapability, type Identity } from "./index.ts";

// --- Outcome envelope -------------------------------------------------------
// Every guard (and the dispatcher) returns this. Shared, frozen singletons keep
// the envelope strings identical across the whole authz surface - tests pin the
// `code`, not just the status - and make the non-leak contract STRUCTURAL: a
// hidden resource and a missing one return the very same FORBIDDEN value, so the
// guard cannot reveal which.
export type AuthzOutcome =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404; code: string };

export const ALLOW: AuthzOutcome = Object.freeze({ ok: true });

// 401 is reserved for "no identity at all" and is minted only by the dispatcher's
// authn stage; a guard never returns it, because guards run only once an
// identity has been resolved.
export const UNAUTHENTICATED: AuthzOutcome = Object.freeze({
  ok: false,
  status: 401,
  code: "unauthenticated",
});

// The single 403 envelope shared by EVERY denial - a missing capability, a
// failed owner/self/scope check, and an inaccessible-or-missing resource alike.
// Uniform by design: a caller cannot distinguish "you lack the capability" from
// "that room is hidden" from "that agent does not exist".
export const FORBIDDEN: AuthzOutcome = Object.freeze({
  ok: false,
  status: 403,
  code: "forbidden",
});

// --- Injected office-state seam ---------------------------------------------
// The ONLY channel through which guards read mutable office state. Narrow and
// synchronous by contract. Production wiring (built at the server/isomux-office.ts seam
// in Phase 2.3/3) supplies the live lookups; tests supply fakes.
export interface GuardDeps {
  // Does this identity have access to `roomId`? Wraps the live RULE-BASED
  // predicate (owners reach every room by rule; members by their grants in
  // `allowedRooms`). NON-LEAK: callers must not branch on the reason; false is
  // false. Phase 3b swapped the body to rule-based access without touching this
  // signature.
  hasRoomAccess(identity: Identity, roomId: string): boolean;
  // The agent's current roomId, or null if the agent does not exist. A null
  // collapses with "inaccessible" into one indistinguishable deny.
  roomIdForAgent(agentId: string): string | null;
  // The userId that owns `username`, or null if unknown.
  userIdForUsername(username: string): string | null;
  // The creator userId of `cronjobId`, or null if unknown / unowned.
  cronjobCreatorUserId(cronjobId: string): string | null;
  // The OWNER userId of the app registered under `name`, or null if no such app
  // exists / it has no owner. Unknown and unowned collapse into the same null,
  // so a caller cannot use a denial to probe which names are taken.
  appOwnerUserId(name: string): string | null;
  // Whether userId names a live office owner. Agent identities carry their
  // boss's userId, so app authorization can grant the boss's office-wide reach
  // without making Identity.role authoritative outside USER scope.
  isOfficeOwnerUserId(userId: string): boolean;
  // The MANAGER userId of `agentId` - the spawning user (AgentInfo.userId) - or
  // null if the agent is unknown / unowned. Gates agents.setPrivileged: a member
  // may toggle privilege only on agents they manage.
  agentManagerUserId(agentId: string): string | null;
  // The MANAGER userId of a KILLED agent - one that has left the live roster but
  // whose logs remain on disk - or null when `agentId` is LIVE, unknown, or has
  // no recorded manager. Deliberately separate from the two live lookups above:
  // it reads the killed list, and every route that does not want dead agents in
  // scope simply does not ask for it.
  killedAgentManagerUserId(agentId: string): string | null;
}

// What a guard sees. `params`/`body` are extracted by the route layer (Phase
// 2.3); in 2.2 the contract tests pass them directly. `body` is `unknown` -
// guards that read it (senderMustEqualTokenAgent) narrow defensively.
export interface GuardContext {
  identity: Identity;
  params: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  deps: GuardDeps;
}

export type Guard = (ctx: GuardContext) => AuthzOutcome;

// --- requiresRoomAccess reference -------------------------------------------
// Where a room-scoped guard reads its room reference. An explicit union (rather
// than a stringly-typed lookup) so a route declares intent, and so ref
// resolution is centralized and testable - every unresolved path collapses to
// the same non-leak deny.
export type RoomRef =
  | { kind: "paramRoomId"; name: string } // params[name] is a roomId (e.g. :roomId)
  | { kind: "paramAgentId"; name: string } // params[name] is an agentId → its room (e.g. :id)
  | { kind: "bodyRoomId"; name: string }; // body[name] is a roomId (e.g. SpawnReq.roomId)

// Resolve a RoomRef to a concrete roomId, or null when it cannot be resolved
// (missing/blank param, wrong body shape, or an agentId with no live room).
// EVERY null path is a non-leak deny at the call site - never a distinct error.
function resolveRoomId(
  ref: RoomRef,
  params: GuardContext["params"],
  body: unknown,
  deps: GuardDeps,
): string | null {
  switch (ref.kind) {
    case "paramRoomId": {
      const v = params[ref.name];
      return v ? v : null;
    }
    case "paramAgentId": {
      const agentId = params[ref.name];
      if (!agentId) return null;
      return deps.roomIdForAgent(agentId);
    }
    case "bodyRoomId": {
      if (typeof body !== "object" || body === null) return null;
      const v = (body as Record<string, unknown>)[ref.name];
      return typeof v === "string" && v.length > 0 ? v : null;
    }
  }
}

// --- The catalog ------------------------------------------------------------

// `public` in the spec. Always allows: it is the declared marker for the
// pre-authn login/static surface, which is served BEFORE the dispatcher (so the
// dispatcher's null-identity → 401 rule never applies to it). Named with a
// `Guard` suffix because `public` is a reserved word. NOTE for 2.3: route public
// surfaces AROUND authorize(), never through it with a null identity - the
// dispatcher intentionally maps a null identity to 401 before any guard runs.
export const publicGuard: Guard = () => ALLOW;

// Any resolved OFFICE identity satisfies it - a human, an agent, a cron run.
// (The dispatcher already converted "no identity" into 401 before stage 2; this
// is the explicit "any authenticated caller, no object-level restriction"
// marker.)
//
// APP and API scopes are exceptions, and the reason this is no longer a bare
// `() => ALLOW`. On a capability route the exclusion is mostly redundant - an
// app token holds one capability that no other route asks for - but on the
// handful of `authenticated`-kind routes (system.version, sessions.logout) this
// guard IS the whole gate, and "any identity at all" would quietly hand those to
// a registered app the moment app tokens existed. An app is agent-authored code
// serving strangers; it opts IN to a route deliberately, one route at a time,
// through appScope below, never by being merely authenticated.
export const authenticated: Guard = ({ identity }) =>
  identity.scope === "app" || identity.scope === "api" ? FORBIDDEN : ALLOW;

// Capability-gated operational routes admit a remote-boss API identity. Keep
// this separate from authenticated: that guard is also the whole gate on
// sessions.logout, which has no meaning for an API token and stays denied.
export const operationalAuthenticated: Guard = ({ identity }) =>
  identity.scope === "app" ? FORBIDDEN : ALLOW;

export const agentTokenSender: Guard = ({ identity }) =>
  identity.scope === "agent" &&
  typeof identity.agentId === "string" &&
  identity.agentId.length > 0
    ? ALLOW
    : FORBIDDEN;

export const apiTokenInboxSelf: Guard = ({ identity }) =>
  identity.scope === "api" &&
  typeof identity.apiTokenId === "string" &&
  identity.apiTokenId.length > 0
    ? ALLOW
    : FORBIDDEN;

// APP-scope gate: the opt-in half of the rule above, and the ONLY guard that
// admits an app. Paired with the app:message capability on the one route an app
// reaches (apps.sendMessage), which is belt and braces on purpose: the
// capability alone already excludes every other scope, but then a future edit to
// a capability SET would be the only thing standing between an agent token and
// this route. Two independent facts have to change for that to happen.
//
// `appName` is required rather than assumed. It is what the handler resolves the
// app record from, so an app identity without one is a bug upstream, and the
// safe reading of a bug here is "not this app's route".
export const appScope: Guard = ({ identity }) =>
  identity.scope === "app" && !!identity.appName ? ALLOW : FORBIDDEN;

// The caller has an OWNING USER. Composed onto routes that create something a
// user must own afterwards - today apps.register.
//
// This is an identity SEMANTIC, not body validation, which is why it is a guard
// rather than a check in the handler: `userId` is null for an agent token minted
// without a spawning user (mintAgentToken's second parameter is nullable), and
// an app registered by such a token would belong to nobody. It would then be
// invisible and undeletable to the very agent that created it - appOwnerUserId
// returns null, which owner-matches nothing - leaving an office owner as the
// only party who could clean it up. Refusing at the door is the difference
// between "you cannot do that" and a resource nobody can reach.
export const hasOwningUser: Guard = ({ identity }) =>
  identity.userId ? ALLOW : FORBIDDEN;

// USER-only owner gate. `scope === "user"` is REQUIRED so a non-user identity
// can never be authorized via role - role is an inert "member" filler for AGENT
// and CRON-RUN scope (see Identity.role). Stage-1 capabilities already block
// non-users from owner routes; this is defense-in-depth, gate-ready for the
// Reviewer4 security pass.
export const officeOwner: Guard = ({ identity }) =>
  identity.scope === "user" && identity.role === "owner" ? ALLOW : FORBIDDEN;

// USER-scope gate. Any user identity (owner OR member) passes; AGENT and
// CRON-RUN never do - a privileged agent stays scope==="agent", so it cannot
// pass either. This is the scope half of the agents.setPrivileged double-gate:
// composed with a room-access guard (agentParam) so a user may toggle privilege
// only on an agent they can reach (owner office-wide, member their own rooms),
// while no agent - privileged or not - can ever flip the flag.
export const userScope: Guard = ({ identity }) =>
  identity.scope === "user" ? ALLOW : FORBIDDEN;

// USER-only self gate for /users/:username routes: `:username` must resolve to
// the caller's own userId. scope-gated so an AGENT (which carries its spawning
// user's userId) can never pass as that user.
export const selfUser: Guard = ({ identity, params, deps }) => {
  if (identity.scope !== "user") return FORBIDDEN;
  const username = params.username;
  if (!username) return FORBIDDEN;
  const targetUserId = deps.userIdForUsername(username);
  return targetUserId !== null && targetUserId === identity.userId
    ? ALLOW
    : FORBIDDEN;
};

// USER edit/delete: self OR office owner. Both branches are USER-gated (each of
// officeOwner and selfUser requires scope === "user").
export const selfOrOwner: Guard = (ctx) =>
  officeOwner(ctx).ok ? ALLOW : selfUser(ctx);

// AGENT-only self-affordance gate: the `:id` path param must equal the token's
// agentId. USER and CRON-RUN identities carry no agentId, so they can NEVER
// satisfy it (impossibility-by-construction). The binding must be a NON-EMPTY
// string, so a fabricated identity with a blank agentId cannot `"" === ""`-match
// a blank param (equality then propagates non-emptiness to the param side).
export const agentParamMustEqualTokenAgent: Guard = ({ identity, params }) =>
  identity.scope === "agent" &&
  typeof identity.agentId === "string" &&
  identity.agentId.length > 0 &&
  identity.agentId === params.id
    ? ALLOW
    : FORBIDDEN;

// Inter-agent message: sender authority IS the token (AGENT scope). The legacy
// `body.senderAgentId` is optional input - rejected if present and not equal to
// the token's agentId, ignored otherwise. USER/CRON-RUN can't satisfy (not agent
// scope / no agentId); a blank agentId is rejected too (not a valid sender).
export const senderMustEqualTokenAgent: Guard = ({ identity, body }) => {
  if (
    identity.scope !== "agent" ||
    typeof identity.agentId !== "string" ||
    identity.agentId.length === 0
  )
    return FORBIDDEN;
  if (typeof body === "object" && body !== null) {
    const sender = (body as Record<string, unknown>).senderAgentId;
    if (sender !== undefined && sender !== identity.agentId) return FORBIDDEN;
  }
  return ALLOW;
};

// CRON-RUN-only affordance gate: the `{:id, :runId}` path params must equal the
// token's `{cronjobId, runId}`. USER/AGENT lack these bindings, so they can
// never satisfy it. Both bindings must be NON-EMPTY strings, so a fabricated run
// identity with blank ids cannot `"" === ""`-match blank params.
export const runParamMustEqualTokenRun: Guard = ({ identity, params }) =>
  identity.scope === "cron-run" &&
  typeof identity.cronjobId === "string" &&
  identity.cronjobId.length > 0 &&
  typeof identity.runId === "string" &&
  identity.runId.length > 0 &&
  identity.cronjobId === params.id &&
  identity.runId === params.runId
    ? ALLOW
    : FORBIDDEN;

// USER manages the agent: `:id`'s manager (its spawning user's userId) equals
// the caller's userId. Gates the agents.setPrivileged toggle for a member (an
// owner takes the officeOwner branch). NON-LEAK: an unknown agent (null manager)
// denies identically to a foreign one. A null caller userId never matches.
//
// COMPOSE UNDER userScope: this checks ONLY the userId match, so a non-user
// identity whose userId coincided with the agent's manager would pass it in
// ISOLATION. The route wraps it as `and(userScope, or(officeOwner, this))`, where
// userScope is what keeps every agent (privileged or not) out at stage 2 - do
// NOT use this bare, or a userId coincidence would leak the toggle to an agent.
export function agentManagerMatch(idParamName = "id"): Guard {
  return ({ identity, params, deps }) => {
    const agentId = params[idParamName];
    if (!agentId) return FORBIDDEN;
    const managerUserId = deps.agentManagerUserId(agentId);
    return managerUserId !== null && managerUserId === identity.userId
      ? ALLOW
      : FORBIDDEN;
  };
}

// Room/agent-scoped access. Resolves the room reference (agent → room when the
// ref is an agentId) and then checks access. NON-LEAK: a missing/blank ref, an
// unknown agent, and an inaccessible-but-existing room ALL deny with the
// identical FORBIDDEN envelope - the guard never reveals which.
export function requiresRoomAccess(ref: RoomRef): Guard {
  return ({ identity, params, body, deps }) => {
    // An APP reaches no room, and this is checked HERE rather than left to the
    // dep because the dep cannot express it: hasRoomAccess keys on the
    // identity's userId, and an app's userId is its OWNER's. Without this line
    // a registered app would inherit every room its owner can reach - and with
    // it every room-gated route that asks for no capability, which is exactly
    // the confused deputy an app token must never become.
    if (identity.scope === "app") return FORBIDDEN;
    const roomId = resolveRoomId(ref, params, body, deps);
    if (roomId === null) return FORBIDDEN;
    return deps.hasRoomAccess(identity, roomId) ? ALLOW : FORBIDDEN;
  };
}

// App read/delete: the USER who OWNS the app, an office owner, an agent whose
// spawning user owns it, or an API token issued by that owner. Reached by
// apps.get and apps.delete; apps.list
// is filtered per-caller in the handler instead (there is no :name to gate on).
//
// Shaped like cronjobOwnerOrOfficeOwner, with ONE semantic difference that is
// easy to miss when reading them side by side. There, `cron:manage` is the
// PRIVILEGE signal: an ordinary agent does not hold it, so only a deliberately
// privileged one reaches the owner-match. Here `app:read` is BASELINE for every
// agent - an agent managing the apps its user owns is the entire feature, not
// an escalation. What keeps that safe is the owner match itself, which binds an
// agent to its own manager's apps and nobody else's; the capability check
// remains as the participation signal that denies a CRON-RUN identity (which
// holds neither app capability) even when this guard is contract-tested in
// isolation with no stage 1 above it.
//
// An unknown name denies exactly like another user's app, so a denial is never
// an oracle for which names are taken. That matters more here than elsewhere:
// names are unique across the whole office, so "is this name free" is a real
// question a caller might want answered, and registration is the only place it
// gets an answer.
//
// An agent whose boss is an office owner deliberately gets the same office-wide
// app control (task 3cd85856, Nil's 2026-08-31 ruling). This is a separate,
// AGENT-only branch: officeOwner stays USER-only, and API/cron/app identities do
// not inherit the grant through a matching userId.
export function appOwnerOrOfficeOwner(nameParamName = "name"): Guard {
  return (ctx) => {
    const { identity, params, deps } = ctx;
    const participates =
      identity.scope === "user" ||
      identity.scope === "api" ||
      (identity.scope === "agent" &&
        identityHasCapability(identity, "app:read"));
    if (!participates) return FORBIDDEN;
    if (officeOwner(ctx).ok) return ALLOW;
    if (
      identity.scope === "agent" &&
      identity.userId !== null &&
      deps.isOfficeOwnerUserId(identity.userId)
    ) {
      return ALLOW;
    }
    const name = params[nameParamName];
    if (!name) return FORBIDDEN;
    const ownerUserId = deps.appOwnerUserId(name);
    return ownerUserId !== null && ownerUserId === identity.userId
      ? ALLOW
      : FORBIDDEN;
  };
}

// Cronjob mutate/run: the USER who created the cronjob, an office owner, a
// PRIVILEGED agent whose spawning user created it, or the creator's API token.
//
// By default an AGENT carries its spawning user's userId, so a NARROW agent
// inheriting that user's cronjob ownership would be a confused-deputy
// escalation - which is why a normal agent never holds `cron:manage` and is
// blocked at stage 1 before this guard runs. A PRIVILEGED agent is granted
// cron:manage deliberately (task 98d63ef7, Nil-approved), so here we let it
// own-match exactly like its user would. The privilege signal is the capability
// itself (keying authz on scope + capabilities, never a separate role/flag
// axis), so a cron-run or normal-agent identity - neither of which carries
// cron:manage - still can't reach the owner-match.
//
// The officeOwner branch is unchanged and still requires scope==="user" + owner,
// so a privileged agent can NEVER get office-wide cron powers - only its own
// jobs. (cron.setPrompt keeps its own officeOwner guard and stays owner-only.)
export function cronjobOwnerOrOfficeOwner(idParamName = "id"): Guard {
  return (ctx) => {
    const { identity, params, deps } = ctx;
    const isUser = identity.scope === "user";
    // The in-guard cap check is the PRIVILEGE SIGNAL, not redundant bookkeeping:
    // do NOT delete it assuming stage-1 `cron:manage` covers it. This guard is
    // contract-tested in isolation (no stage 1), and the check is what tells a
    // privileged agent (granted cron:manage) apart from a narrow one - and from
    // a cron-run, which never holds it. Removing it (or simplifying to a bare
    // `scope === "agent"`) would let any agent own-match cronjobs.
    const isPrivilegedOperator =
      (identity.scope === "agent" || identity.scope === "api") &&
      identityHasCapability(identity, "cron:manage");
    if (!isUser && !isPrivilegedOperator) return FORBIDDEN;
    if (officeOwner(ctx).ok) return ALLOW;
    const cronjobId = params[idParamName];
    if (!cronjobId) return FORBIDDEN;
    const creatorUserId = deps.cronjobCreatorUserId(cronjobId);
    return creatorUserId !== null && creatorUserId === identity.userId
      ? ALLOW
      : FORBIDDEN;
  };
}

// Composite send-message guard. CALLER AUTHORIZATION ONLY:
//   USER     → requiresRoomAccess(:id-as-agent); an absent recipient and a
//              hidden recipient collapse to the same non-leak deny. The sender
//              is derived from the cookie/identity by the handler, never the body.
//   AGENT    → senderMustEqualTokenAgent; cross-room delivery is allowed, so NO
//              room-access check is applied to an agent sender.
//   CRON-RUN → creator-room access, matching the GET /agents projection. A run
//              can message exactly the live agents it can discover. Resolve the
//              live job creator instead of widening accessibleRoomIdsForIdentity:
//              that helper deliberately stays empty for cron task-board scope.
//
// NOT in this guard, deliberately: recipient EXISTENCE (for the AGENT branch)
// and pendingPermission OWNERSHIP. Those are send-message SEMANTIC preconditions
// the handler/core op enforces against live orchestrator state - while a
// pendingPermission is set for `:id`, the next message to THAT agent is
// interpreted as an allow/deny, so interpretation must bind to `:id`. They are
// listed on the route contract, not as resourceGuard authorization. Keeping them
// out preserves guard purity (no live-state dependency) while the exported name
// stays `messageSend` to match the spec row.
const messageSendUserGuard = requiresRoomAccess({
  kind: "paramAgentId",
  name: "id",
});
export const messageSend: Guard = (ctx) => {
  switch (ctx.identity.scope) {
    case "user":
      return messageSendUserGuard(ctx);
    case "agent":
      return senderMustEqualTokenAgent(ctx);
    case "cron-run": {
      const cronjobId = ctx.identity.cronjobId;
      const recipientId = ctx.params.id;
      if (!cronjobId || !recipientId) return FORBIDDEN;
      const creatorUserId = ctx.deps.cronjobCreatorUserId(cronjobId);
      if (!creatorUserId || creatorUserId !== ctx.identity.userId)
        return FORBIDDEN;
      const roomId = ctx.deps.roomIdForAgent(recipientId);
      if (!roomId) return FORBIDDEN;
      return ctx.deps.hasRoomAccess(ctx.identity, roomId) ? ALLOW : FORBIDDEN;
    }
    case "api":
      return messageSendUserGuard(ctx);
    // An app messaging its agent is the NEXT slice's feature, and it arrives as
    // its own capability and its own guard - not as an app slipping through the
    // route agents use to message each other, where the sender authority is a
    // token agentId an app does not have.
    case "app":
      return FORBIDDEN;
  }
};

// Task DELETE: USER or AGENT only.
//
// A cron run holds task:read + task:write so it can file and complete tasks the
// way its system prompt describes. But `task:write` is one coarse capability
// covering create/update/claim/done/delete, and the surface a run inherited (the
// retired loopback /tasks route) answered DELETE with a 405 wall - so granting a
// run the board would otherwise hand it a delete power it never had, over any
// office-global task. Nothing about an unattended scheduled run wants that.
// USER, AGENT and remote-boss API callers keep delete. An APP holds no
// task capability at all, so it never reaches this guard through the dispatcher
// - named here anyway, because a guard whose deny list is "everything except
// the scopes I happened to know about" is one new scope away from being wrong.
export const taskDelete: Guard = ({ identity }) =>
  identity.scope === "user" ||
  identity.scope === "agent" ||
  identity.scope === "api"
    ? ALLOW
    : FORBIDDEN;

// Scheduled-message OUTBOX guard (agents.listScheduledMessages /
// agents.cancelScheduledMessage). `:id` here is the SENDER whose pending
// scheduled messages are being managed - the deliberate asymmetry with the
// sibling send route, where `:id` is the recipient. Scope-switched like
// messageSend:
//   USER     → room access to the sender agent's room (a boss who can reach
//              the agent can inspect/cancel its outbox - same authority shape
//              as cancelling its queued messages).
//   AGENT    → `:id` must equal the token agent: an agent manages ONLY its own
//              outbox. Deliberately NOT room-based - room-mates must not read
//              or cancel each other's pending scheduled messages.
//   API      → the issuing user manages reachable agent outboxes.
//   CRON-RUN → deny (a run has no outbox).
export const scheduledMessagesOwner: Guard = (ctx) => {
  switch (ctx.identity.scope) {
    case "user":
      return messageSendUserGuard(ctx);
    case "agent":
      return agentParamMustEqualTokenAgent(ctx);
    case "cron-run":
      return FORBIDDEN;
    case "app": // no outbox, and no agent id to bind one to
      return FORBIDDEN;
    case "api":
      return messageSendUserGuard(ctx);
  }
};

// Conversation reset (agents.newConversation): who may clear an agent's session
// and start it fresh.
//   USER     → room access to the target agent (an operator clears agents it
//              can see), unchanged.
//   AGENT    → a PRIVILEGED agent (holds agent:converse - granted so it can
//              drive other agents' sessions the way its user does) clears any
//              agent in an accessible room, exactly as today; an ORDINARY agent
//              (self:affordance only, no agent:converse) may clear ONLY ITSELF.
//              The privilege signal is the CAPABILITY, not scope alone - same
//              shape as cronjobOwnerOrOfficeOwner. It matters here because
//              hasRoomAccess keys on the agent's SPAWNING-USER id, so a bare
//              room check would let any ordinary agent clear every other agent
//              its user owns (a confused-deputy escalation). The self branch
//              binds to the token agentId, so that path is self-only by
//              construction.
//   CRON-RUN → deny (a run has no session to reset).
export const conversationReset: Guard = (ctx) => {
  switch (ctx.identity.scope) {
    case "user":
      return messageSendUserGuard(ctx);
    case "agent":
      return identityHasCapability(ctx.identity, "agent:converse")
        ? messageSendUserGuard(ctx)
        : agentParamMustEqualTokenAgent(ctx);
    case "cron-run":
      return FORBIDDEN;
    case "app": // an app has no session of its own, and none over an agent
      return FORBIDDEN;
    case "api":
      return messageSendUserGuard(ctx);
  }
};

// Conversation-log READ (agents.logs): who may search and retrieve an agent's
// history.
//   USER     → room access to the target agent, exactly like every other read
//              surface. A boss already reads these conversations in the UI.
//   AGENT    → ITSELF, or any agent sitting in a room accessible to its
//              SPAWNING USER. Note that this is broader than "the caller's own
//              room": requiresRoomAccess asks whether the principal can reach
//              the TARGET's room, not whether the two share one, so an agent
//              reaches every room its boss can - which is the stated scope.
//   CRON-RUN → deny (a run has no history, and holds no log:read anyway).
// Plus, for a target that has been KILLED: its own boss, or an office owner.
//
// WHY THE BARE ROOM CHECK IS CORRECT HERE, when conversationReset above warns
// against exactly that shape: the warning there is about a MUTATION. Clearing
// another agent's session via a room check would be a confused-deputy
// escalation, because hasRoomAccess keys on the agent's SPAWNING-USER id, so
// any ordinary agent could reset every other agent its boss owns.
//
// This route is a READ, and "every agent in rooms its boss can access" is the
// scope that was chosen for it deliberately - it supersedes an earlier
// self-only design. The spawning-user keying is not an accident being exploited
// here; it is precisely how "its boss's rooms" is expressed in this codebase.
// Nothing becomes visible that the boss could not already read in the UI.
//
// The SELF branch is checked FIRST and independently, so an agent never loses
// access to its own history because its room's grants changed underneath it.
//
// KILLED AGENTS take a second path (killedAgentLogAccess below), because the
// room path cannot serve them: roomIdForAgent resolves through the LIVE roster,
// so a killed agent - whose logs are all still on disk - denies exactly like an
// unknown id.
const logReadRoomGuard = requiresRoomAccess({
  kind: "paramAgentId",
  name: "id",
});

// Killed-agent log reach (task ffb90761). A DIFFERENT rule from the live one,
// not a room check against a stale room: the killed agent's own boss - the user
// that spawned it - plus office owners, nobody else. Room grants move after a
// kill and a dead agent's last room is a fact about the past; who spawned it is
// not. Narrower than the live rule too: a room-mate of the killed agent gets
// nothing here unless they share its boss.
//
// COMPOSE UNDER A SCOPE SWITCH, like agentManagerMatch: this checks the userId
// match alone, and an AGENT identity carries its spawning user's userId - which
// is what makes "an agent reaches its boss's killed agents" work, and what would
// leak the surface to a cron run if this were ever used bare. logSearchAccess
// denies cron-run before reaching it.
export const killedAgentLogAccess: Guard = (ctx) => {
  if (officeOwner(ctx).ok) return ALLOW;
  const agentId = ctx.params.id;
  if (!agentId) return FORBIDDEN;
  const managerUserId = ctx.deps.killedAgentManagerUserId(agentId);
  return managerUserId !== null && managerUserId === ctx.identity.userId
    ? ALLOW
    : FORBIDDEN;
};

export const logSearchAccess: Guard = (ctx) => {
  switch (ctx.identity.scope) {
    case "user":
      return logReadRoomGuard(ctx).ok ? ALLOW : killedAgentLogAccess(ctx);
    case "agent":
      return agentParamMustEqualTokenAgent(ctx).ok || logReadRoomGuard(ctx).ok
        ? ALLOW
        : killedAgentLogAccess(ctx);
    case "cron-run":
      return FORBIDDEN;
    // An app reads no conversations. Its owning user's id is on the identity
    // for attribution, and killedAgentLogAccess own-matches on exactly that -
    // so this branch is what stops a truthful field from becoming an authority.
    case "app":
      return FORBIDDEN;
    case "api":
      return logReadRoomGuard(ctx).ok ? ALLOW : killedAgentLogAccess(ctx);
  }
};

// --- Combinators ------------------------------------------------------------
// Typed composition for the route table's compound guards (e.g. agents.move /
// agents.revive need access to BOTH the source and target room). Encoding these
// as combinators rather than free-form strings keeps the route table's authz
// slice machine-checkable: a contract test can reason about `and(g1, g2)` the
// same way it reasons about a leaf guard.

// All must allow (first-deny-wins). The first non-ALLOW outcome is returned
// verbatim, preserving its status/code for the non-leak envelope; if every
// guard allows, ALLOW. An empty composition allows (vacuous truth) - callers
// pass at least one guard in practice.
export function and(...guards: readonly Guard[]): Guard {
  return (ctx) => {
    for (const g of guards) {
      const outcome = g(ctx);
      if (!outcome.ok) return outcome;
    }
    return ALLOW;
  };
}

// Any may allow (first-allow-wins). Returns ALLOW on the first passing guard;
// otherwise the LAST denial verbatim (so a meaningful status/code survives
// rather than a synthesized one). An empty composition denies with FORBIDDEN.
export function or(...guards: readonly Guard[]): Guard {
  return (ctx) => {
    let lastDeny: AuthzOutcome = FORBIDDEN;
    for (const g of guards) {
      const outcome = g(ctx);
      if (outcome.ok) return ALLOW;
      lastDeny = outcome;
    }
    return lastDeny;
  };
}
