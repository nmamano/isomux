// Guard catalog — Phase 2.2. Named, individually contract-tested authorization
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
// server/index.ts, the managers, or users.ts — mutable office state reaches
// guards ONLY through the injected `GuardDeps` seam. That keeps the catalog pure
// and unit-testable, and let Phase 3b swap the access model (materialized
// `allowedRooms` → rule-based) by replacing the GuardDeps implementation, never
// a guard signature.

import { identityHasCapability, type Identity } from "./index.ts";

// --- Outcome envelope -------------------------------------------------------
// Every guard (and the dispatcher) returns this. Shared, frozen singletons keep
// the envelope strings identical across the whole authz surface — tests pin the
// `code`, not just the status — and make the non-leak contract STRUCTURAL: a
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

// The single 403 envelope shared by EVERY denial — a missing capability, a
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
// synchronous by contract. Production wiring (built at the server/index.ts seam
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
  // The MANAGER userId of `agentId` — the spawning user (AgentInfo.userId) — or
  // null if the agent is unknown / unowned. Gates agents.setPrivileged: a member
  // may toggle privilege only on agents they manage.
  agentManagerUserId(agentId: string): string | null;
}

// What a guard sees. `params`/`body` are extracted by the route layer (Phase
// 2.3); in 2.2 the contract tests pass them directly. `body` is `unknown` —
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
// resolution is centralized and testable — every unresolved path collapses to
// the same non-leak deny.
export type RoomRef =
  | { kind: "paramRoomId"; name: string } // params[name] is a roomId (e.g. :roomId)
  | { kind: "paramAgentId"; name: string } // params[name] is an agentId → its room (e.g. :id)
  | { kind: "bodyRoomId"; name: string }; // body[name] is a roomId (e.g. SpawnReq.roomId)

// Resolve a RoomRef to a concrete roomId, or null when it cannot be resolved
// (missing/blank param, wrong body shape, or an agentId with no live room).
// EVERY null path is a non-leak deny at the call site — never a distinct error.
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
// surfaces AROUND authorize(), never through it with a null identity — the
// dispatcher intentionally maps a null identity to 401 before any guard runs.
export const publicGuard: Guard = () => ALLOW;

// Any resolved identity satisfies it. (The dispatcher already converted "no
// identity" into 401 before stage 2; this is the explicit "any authenticated
// caller, no object-level restriction" marker.)
export const authenticated: Guard = () => ALLOW;

// USER-only owner gate. `scope === "user"` is REQUIRED so a non-user identity
// can never be authorized via role — role is an inert "member" filler for AGENT
// and CRON-RUN scope (see Identity.role). Stage-1 capabilities already block
// non-users from owner routes; this is defense-in-depth, gate-ready for the
// Reviewer4 security pass.
export const officeOwner: Guard = ({ identity }) =>
  identity.scope === "user" && identity.role === "owner" ? ALLOW : FORBIDDEN;

// USER-scope gate. Any user identity (owner OR member) passes; AGENT and
// CRON-RUN never do — a privileged agent stays scope==="agent", so it cannot
// pass either. This is the scope half of the agents.setPrivileged double-gate:
// composed with a room-access guard (agentParam) so a user may toggle privilege
// only on an agent they can reach (owner office-wide, member their own rooms),
// while no agent — privileged or not — can ever flip the flag.
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
// `body.senderAgentId` is optional input — rejected if present and not equal to
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
// userScope is what keeps every agent (privileged or not) out at stage 2 — do
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
// identical FORBIDDEN envelope — the guard never reveals which.
export function requiresRoomAccess(ref: RoomRef): Guard {
  return ({ identity, params, body, deps }) => {
    const roomId = resolveRoomId(ref, params, body, deps);
    if (roomId === null) return FORBIDDEN;
    return deps.hasRoomAccess(identity, roomId) ? ALLOW : FORBIDDEN;
  };
}

// Cronjob mutate/run: the USER who created the cronjob, OR an office owner, OR
// a PRIVILEGED agent whose spawning user created it.
//
// By default an AGENT carries its spawning user's userId, so a NARROW agent
// inheriting that user's cronjob ownership would be a confused-deputy
// escalation — which is why a normal agent never holds `cron:manage` and is
// blocked at stage 1 before this guard runs. A PRIVILEGED agent is granted
// cron:manage deliberately (task 98d63ef7, Nil-approved), so here we let it
// own-match exactly like its user would. The privilege signal is the capability
// itself (keying authz on scope + capabilities, never a separate role/flag
// axis), so a cron-run or normal-agent identity — neither of which carries
// cron:manage — still can't reach the owner-match.
//
// The officeOwner branch is unchanged and still requires scope==="user" + owner,
// so a privileged agent can NEVER get office-wide cron powers — only its own
// jobs. (cron.setPrompt keeps its own officeOwner guard and stays owner-only.)
export function cronjobOwnerOrOfficeOwner(idParamName = "id"): Guard {
  return (ctx) => {
    const { identity, params, deps } = ctx;
    const isUser = identity.scope === "user";
    // The in-guard cap check is the PRIVILEGE SIGNAL, not redundant bookkeeping:
    // do NOT delete it assuming stage-1 `cron:manage` covers it. This guard is
    // contract-tested in isolation (no stage 1), and the check is what tells a
    // privileged agent (granted cron:manage) apart from a narrow one — and from
    // a cron-run, which never holds it. Removing it (or simplifying to a bare
    // `scope === "agent"`) would let any agent own-match cronjobs.
    const isPrivilegedAgent =
      identity.scope === "agent" &&
      identityHasCapability(identity, "cron:manage");
    if (!isUser && !isPrivilegedAgent) return FORBIDDEN;
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
//   CRON-RUN → deny (a run has no chat to send into).
//
// NOT in this guard, deliberately: recipient EXISTENCE (for the AGENT branch)
// and pendingPermission OWNERSHIP. Those are send-message SEMANTIC preconditions
// the handler/core op enforces against live orchestrator state — while a
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
    case "cron-run":
      return FORBIDDEN;
  }
};

// Scheduled-message OUTBOX guard (agents.listScheduledMessages /
// agents.cancelScheduledMessage). `:id` here is the SENDER whose pending
// scheduled messages are being managed — the deliberate asymmetry with the
// sibling send route, where `:id` is the recipient. Scope-switched like
// messageSend:
//   USER     → room access to the sender agent's room (a boss who can reach
//              the agent can inspect/cancel its outbox — same authority shape
//              as cancelling its queued messages).
//   AGENT    → `:id` must equal the token agent: an agent manages ONLY its own
//              outbox. Deliberately NOT room-based — room-mates must not read
//              or cancel each other's pending scheduled messages.
//   CRON-RUN → deny (a run has no outbox).
export const scheduledMessagesOwner: Guard = (ctx) => {
  switch (ctx.identity.scope) {
    case "user":
      return messageSendUserGuard(ctx);
    case "agent":
      return agentParamMustEqualTokenAgent(ctx);
    case "cron-run":
      return FORBIDDEN;
  }
};

// Conversation reset (agents.newConversation): who may clear an agent's session
// and start it fresh.
//   USER     → room access to the target agent (an operator clears agents it
//              can see), unchanged.
//   AGENT    → a PRIVILEGED agent (holds agent:converse — granted so it can
//              drive other agents' sessions the way its user does) clears any
//              agent in an accessible room, exactly as today; an ORDINARY agent
//              (self:affordance only, no agent:converse) may clear ONLY ITSELF.
//              The privilege signal is the CAPABILITY, not scope alone — same
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
// guard allows, ALLOW. An empty composition allows (vacuous truth) — callers
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
