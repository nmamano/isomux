// Identity & capabilities — the stable type / capability / auth-helper surface
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

// A token (or cookie) resolves to one of three identity scopes. Scope is
// orthogonal to role: a USER identity additionally carries owner/member, which
// guards consult; AGENT and CRON-RUN identities are non-user and never gate on
// role (see Identity.role).
export type TokenScope = "user" | "agent" | "cron-run";

// The capability lattice. A capability gates a class of operations; the route
// table's `requiredCapability` is checked against the identity's set before any
// handler runs. The set grows additively (capability-lattice expansion is a
// follow-up); do not repurpose an existing capability's meaning.
export type Capability =
  // USER (browser) capabilities — held by any human identity (owner or member),
  // narrowed further by resource guards (officeOwner, selfOrOwner, …).
  | "office:read"
  | "agent:manage"
  | "agent:converse"
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
  // Shared by USER and AGENT — the global task board.
  | "task:read"
  | "task:write"
  // AGENT-identity capabilities — deliberately absent from USER scope (a human
  // is not an agent and has no own-chat).
  | "agent:send-as-self"
  | "self:affordance";

// A resolved caller identity. Produced from a cookie session
// (identityFromSession) or a bearer token (resolveToken in ./tokens.ts).
export interface Identity {
  scope: TokenScope;
  // The owning/acting user. For USER scope this is the human; for AGENT scope
  // the spawning user (drives token-derived attribution); for CRON-RUN scope
  // the cronjob's creator (may be null for an unowned job).
  userId: string | null;
  // Present only on the corresponding scope.
  agentId?: string;
  cronjobId?: string;
  runId?: string;
  // Role is meaningful ONLY for USER scope (owner-only routes are gated by the
  // officeOwner guard on a USER identity). For AGENT and CRON-RUN scope it is
  // an inert least-privilege filler ("member"). Authorization for non-user
  // identities MUST key on scope + capabilities + resource guards, never on
  // role — a role-only guard must never authorize an agent/run identity.
  role: UserRole;
  capabilities: readonly Capability[];
}

// USER (browser) set: every capability except the two agent-identity ones.
// Owner vs member is NOT expressed here — both humans hold this full set and
// owner-only routes are blocked for members by the officeOwner guard, not by a
// missing capability.
export const USER_CAPABILITIES: readonly Capability[] = [
  "office:read",
  "agent:manage",
  "agent:converse",
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
];

// AGENT set: exactly today's loopback surface and no more. An agent can message
// as itself, use the global task board, and use the self-affordances on its own
// chat. It cannot spawn/kill, touch settings, mint invites, mutate cronjobs, or
// read cronjob transcripts — those capabilities are simply absent.
export const AGENT_CAPABILITIES: readonly Capability[] = [
  "agent:send-as-self",
  "task:read",
  "task:write",
  "self:affordance",
];

// CRON-RUN set: only the self-affordances, bound to its {cronjobId, runId}. The
// cron-run analogue of an agent token; closes the loopback hole for a firing
// run's in-flight read-file/diff without relying on a bypass.
export const RUN_CAPABILITIES: readonly Capability[] = ["self:affordance"];

export function capabilitiesForScope(scope: TokenScope): readonly Capability[] {
  switch (scope) {
    case "user":
      return USER_CAPABILITIES;
    case "agent":
      return AGENT_CAPABILITIES;
    case "cron-run":
      return RUN_CAPABILITIES;
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
