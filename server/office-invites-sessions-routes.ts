// The invites and sessions routes: sign-in links (mint, list, revoke) and
// browser sessions (list, revoke, logout). Moved out of buildExecutorDeps in
// server/isomux-office.ts, which registers them and keeps their
// inviteOwnerOrSelf and sessionOwnerOrSelf preconditions.
import {
  buildPublicOrigin,
  INVITE_TTL_MS,
  SELF_INVITE_TTL_MS,
  listActiveSessionsForUserId,
  logoutBySessionHash,
  mintInvite,
  revokeActiveSessionByPrefixForUserId,
  revokeInviteByPrefix,
  revokeOutstandingInviteByPrefixForUser,
  revokeSessionByPrefix,
  toInviteWire,
  type MintErr,
  type RevokeResult,
  type ScopedSessionRevokeResult,
} from "./auth.ts";
import type { EmitContext } from "./events/emit.ts";
import type { EventId, EventPayloads } from "./events/registry.ts";
import type { createAccessPolicy } from "./office-access-policy.ts";
import { getUserById, getUserByName } from "./users.ts";
import type { HandlerErrorStatus, RouteHandler } from "./routes/executor.ts";
import { invitesHandlers } from "./routes/handlers/invites.ts";
import { sessionsHandlers } from "./routes/handlers/sessions.ts";
import type { InviteWire, SessionWire, UserRecord } from "../shared/types.ts";

type LiveEmit = <K extends EventId>(
  id: K,
  payload: EventPayloads[K],
  ctx?: EmitContext,
) => void;

// What the invites routes read from server/isomux-office.ts.
export interface InvitesRoutesDeps {
  attributionFor: ReturnType<typeof createAccessPolicy>["attributionFor"];
  emitInvitesList: () => void;
  liveEmit: LiveEmit;
  scopedInvitesFor: (userId: string | null) => InviteWire[];
}

// What the sessions routes read from server/isomux-office.ts.
export interface SessionsRoutesDeps {
  liveEmit: LiveEmit;
  scopedSessionsFor: (userId: string | null) => SessionWire[];
}

// Map an auth MintErr code → the REST status for the invite mint routes.
function mintErrStatus(code: MintErr["code"]): HandlerErrorStatus {
  switch (code) {
    case "USER_NOT_FOUND":
      return 404;
  }
}

// Lockout reasons of sessions.revoke and sessions.logout, for the invariant
// "the office must always keep one owner with an active session, so an operator
// can recover from inside the browser".
const SESSION_REVOKE_LOCKOUT_REASON =
  "Refused: this is the last active owner session in the office. Mint an " +
  "additional invite for an owner first, accept it on another device, then retry.";
const SESSION_LOGOUT_LOCKOUT_REASON =
  "You're the only owner with an active session. Signing out would lock the " +
  "office out of in-browser recovery. Mint an additional invite for yourself " +
  "and accept it on another device first.";

export function createInvitesRoutes(
  deps: InvitesRoutesDeps,
): Record<string, RouteHandler> {
  const { attributionFor, emitInvitesList, liveEmit, scopedInvitesFor } = deps;
  // Invite-revoke core for the REST invites.revoke dep. Branches owner/member
  // off the user RECORD, calls the matching auth core op, and on success emits
  // invite_revoked (owners-only via liveEmit) + the scoped invites_list fan-out.
  // Returns the raw RevokeResult so the REST dep can apply the non-leak HTTP
  // status policy (owner: honest 404/409; member: uniform 403).
  async function revokeInviteForUserRecord(
    u: UserRecord,
    tokenPrefix: string,
  ): Promise<RevokeResult> {
    const result =
      u.role === "owner"
        ? await revokeInviteByPrefix(tokenPrefix)
        : await revokeOutstandingInviteByPrefixForUser(tokenPrefix, u);
    if (result === "ok") {
      liveEmit("invite_revoked", { tokenPrefix });
      emitInvitesList();
    } else if (result === "ambiguous" && u.role === "owner") {
      // Owner-only diagnostic (a member never learns a prefix is ambiguous - that
      // would leak existence).
      console.warn(
        `[auth] ambiguous invite prefix ${tokenPrefix} - refused revoke`,
      );
    }
    return result;
  }

  // Invites use recipient-scoped emit. EMIT-IN-DEP: there is
  // no auth event sink, so the seam owns mutate→emit - mint/self-mint/revoke fan
  // out emitInvitesList(), and revoke also liveEmits invite_revoked (owners). The
  // handlers stay pure REST mappers. Owner/member resolves from the user RECORD
  // uniformly across the scoped list, the inviteOwnerOrSelf
  // precondition, and the revoke branch; invites.mint alone stays on the table's
  // officeOwner (session) guard - an accepted asymmetry. (The owners-audience
  // fan-out for invite_revoked/session_revoked also keys on session role, via the
  // pre-existing shared ownerSessions in liveEmitDeps.)
  return invitesHandlers({
    // Sign-in link for an EXISTING member (invites.mint, and its permanent
    // alias invites.mintRecovery). userId resolves against the live record.
    // Policy: one outstanding link per member (the mint replaces the prior
    // one) and the standard 24h owner send-and-wait delivery window.
    mint: async (userId, identity) => {
      const { createdBy } = attributionFor(identity);
      const r = await mintInvite({
        userId,
        createdBy,
        ttlMs: INVITE_TTL_MS,
      });
      if (!r.ok) {
        return { ok: false, status: mintErrStatus(r.code), error: r.error };
      }
      emitInvitesList();
      return {
        ok: true,
        url: `${buildPublicOrigin().origin}/i/${r.rawToken}`,
        invite: toInviteWire(r.invite),
      };
    },
    mintSelf: async (identity) => {
      const me = identity.userId ? getUserById(identity.userId) : undefined;
      if (!me) {
        return {
          ok: false,
          status: 404,
          error: "Your user record is missing; reload and try again.",
        };
      }
      const r = await mintInvite({
        userId: me.id,
        createdBy: me.name,
        ttlMs: SELF_INVITE_TTL_MS,
      });
      if (!r.ok) {
        return { ok: false, status: mintErrStatus(r.code), error: r.error };
      }
      emitInvitesList();
      return {
        ok: true,
        url: `${buildPublicOrigin().origin}/i/${r.rawToken}`,
        invite: toInviteWire(r.invite),
      };
    },
    listScoped: (identity) => scopedInvitesFor(identity.userId),
    revoke: async (identity, tokenPrefix) => {
      const u = identity.userId ? getUserById(identity.userId) : undefined;
      // inviteOwnerOrSelf already passed; a missing record here is a torn-down
      // session - uniform 403, no leak.
      if (!u) return { ok: false, status: 403, code: "forbidden" };
      const result = await revokeInviteForUserRecord(u, tokenPrefix);
      if (result === "ok") return { ok: true };
      if (u.role === "owner") {
        // Owner has full visibility, so an honest status leaks nothing.
        return result === "ambiguous"
          ? { ok: false, status: 409, code: "ambiguous_prefix" }
          : { ok: false, status: 404, code: "not_found" };
      }
      // Member post-precondition not_found/ambiguous (TOCTOU): uniform 403,
      // same envelope as the precondition - never reveal which case occurred.
      return { ok: false, status: 403, code: "forbidden" };
    },
  });
}

export function createSessionsRoutes(
  deps: SessionsRoutesDeps,
): Record<string, RouteHandler> {
  const { liveEmit, scopedSessionsFor } = deps;
  // Session-revoke core for the REST sessions.revoke dep. Branches owner/member
  // off the user RECORD; owner uses the unrestricted revoker, member the scoped
  // one. Both check the last-owner lockout inside the auth mutex and return
  // "would_strand_office". On success emits
  // session_revoked (owners-only via liveEmit); sessions_active_list rides
  // fireSessionsChangedHook→emitSessionsList and session_expired + socket close
  // ride the forceExpireSocketsForSession bridge, both inside the auth core ops.
  async function revokeSessionForUserRecord(
    u: UserRecord,
    sessionPrefix: string,
  ): Promise<ScopedSessionRevokeResult> {
    const result =
      u.role === "owner"
        ? await revokeSessionByPrefix(sessionPrefix)
        : await revokeActiveSessionByPrefixForUserId(sessionPrefix, u.id);
    if (result === "ok") {
      liveEmit("session_revoked", { sessionPrefix });
    } else if (result === "ambiguous" && u.role === "owner") {
      console.warn(
        `[auth] ambiguous session prefix ${sessionPrefix} - refused revoke`,
      );
    }
    return result;
  }

  // Sessions use recipient-scoped emit and mirror invites.
  // session_revoked → liveEmit (owners) in the shared core; sessions_active_list
  // rides fireSessionsChangedHook→emitSessionsList; session_expired + socket
  // close ride the forceExpireSocketsForSession bridge inside the auth core ops.
  return sessionsHandlers({
    listScoped: (identity) => scopedSessionsFor(identity.userId),
    listForMember: (username) => {
      const u = getUserByName(username);
      return u
        ? listActiveSessionsForUserId(u.id).map((v) => ({
            sessionPrefix: v.sessionPrefix,
            device: v.device,
            userAgent: v.userAgent,
            createdAt: v.createdAt,
            lastSeenAt: v.lastSeenAt,
          }))
        : [];
    },
    revoke: async (identity, sessionPrefix) => {
      const u = identity.userId ? getUserById(identity.userId) : undefined;
      if (!u) return { ok: false, status: 403, code: "forbidden" };
      const result = await revokeSessionForUserRecord(u, sessionPrefix);
      if (result === "ok") return { ok: true };
      if (result === "would_strand_office") {
        return {
          ok: false,
          status: 409,
          code: "would_strand_office",
          message: SESSION_REVOKE_LOCKOUT_REASON,
        };
      }
      if (u.role === "owner") {
        // Owner has full visibility, so an honest status leaks nothing.
        return result === "ambiguous"
          ? { ok: false, status: 409, code: "ambiguous_prefix" }
          : { ok: false, status: 404, code: "not_found" };
      }
      // Member post-precondition not_found/ambiguous (TOCTOU): uniform 403,
      // same envelope as the precondition - never reveal which case occurred.
      return { ok: false, status: 403, code: "forbidden" };
    },
    logout: async (callerSessionIdHash) => {
      // Fail closed: a bearer (non-cookie) caller has no current browser
      // session to end; NEVER a 204 no-op.
      if (!callerSessionIdHash) {
        return { ok: false, status: 403, code: "forbidden" };
      }
      const result = await logoutBySessionHash(callerSessionIdHash);
      if (result === "would_strand_office") {
        return {
          ok: false,
          status: 409,
          code: "would_strand_office",
          message: SESSION_LOGOUT_LOCKOUT_REASON,
        };
      }
      return { ok: true };
    },
  });
}
