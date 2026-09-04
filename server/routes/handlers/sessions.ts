// Sessions resource handlers. The active-session auth
// surface on the unified REST surface (opIds sessions.{list,revoke,logout}).
//
// Mirrors the 3a.4a invites slice: leaf REST mappers over a slim SessionsDeps;
// the isomux-office.ts seam owns mutate→emit (there is no auth event sink). Owner/member
// resolves from the user RECORD, uniformly across the scoped list,
// the sessionOwnerOrSelf precondition, and the revoke branch.
//
// EMITS (set in the seam, never the handler): session_revoked → liveEmit
// (owners); sessions_active_list → rides fireSessionsChangedHook→emitSessionsList
// (fires from every session mutation); session_expired + socket CLOSE → ride the
// legacy forceExpireSocketsForSession bridge inside the auth core ops (a
// cross-cutting eviction mechanism that also fires on expiry/eviction - the same
// compatibility-bridge category as 3a's cron_run_log_entry; declared in the route
// emits as the target contract but not routed through emit() in 4b).
//
// LOGOUT: DELETE /api/sessions/current ends the caller's OWN cookie session. The
// caller's session hash is threaded in via ctx.callerSessionIdHash (from the
// already-resolved auth result - never re-derived here). A bearer (non-cookie)
// caller has no current session and FAILS CLOSED (403) - never a 204 no-op. The
// HTML POST /auth/logout browser flow stays as-is; this route strangles the WS
// logout arm. Both converge on the shared logoutBySessionHash core.
//
// LEAF over the executor + shared types. Only the injected SessionsDeps surface.

import {
  ok,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { SessionWire } from "../../../shared/types.ts";

// Revoke/logout outcome: ok, or a status-mapped failure the seam already shaped
// per the non-leak policy (owner: honest 404/409; member: uniform 403; lockout:
// 409 with a reason message). The handler maps it 1:1 with no role awareness.
type RevokeOutcome =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; code: string; message?: string };

export interface SessionsDeps {
  // Scoped list for the caller (record role): owner → all; member → own. Direct
  // reply only - NO fan-out (a pure read must never emit to other users).
  listScoped(identity: Identity): SessionWire[];
  // Revoke a session by prefix (precondition sessionOwnerOrSelf + notLastOwner-
  // Lockout already passed). On ok the seam emits session_revoked (owners) and
  // the core op fans out sessions_active_list + session_expired.
  revoke(identity: Identity, sessionPrefix: string): Promise<RevokeOutcome>;
  // End the caller's OWN session. callerSessionIdHash is undefined for a bearer
  // caller → fail closed (403). On ok the core op fans out + closes the socket.
  logout(callerSessionIdHash: string | undefined): Promise<RevokeOutcome>;
}

export function sessionsHandlers(
  deps: SessionsDeps,
): Record<string, RouteHandler> {
  return {
    "sessions.list": (ctx) => ok({ sessions: deps.listScoped(ctx.identity) }),

    "sessions.revoke": async (ctx) => {
      const r = await deps.revoke(ctx.identity, ctx.params.sessionPrefix);
      return r.ok ? noContent() : fail(r.status, r.code, r.message);
    },

    "sessions.logout": async (ctx) => {
      const r = await deps.logout(ctx.callerSessionIdHash);
      return r.ok ? noContent() : fail(r.status, r.code, r.message);
    },
  };
}
