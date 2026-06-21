// Invites resource handlers — Phase 3a slice 3a.4a. The auth invite surface on
// the unified REST surface (opIds invites.{mint,mintSelf,list,revoke}).
//
// Strangler EXPAND: these REST handlers + the still-living WS arms
// (mint_invite / mint_self_invite / list_invites / revoke_invite) BOTH delegate
// to the SAME auth core ops (mintInvite / revokeInviteByPrefix /
// revokeOutstandingInviteByPrefixForUsername) and the SAME recipient-scoped emit
// (emitInvitesList / liveEmit("invite_revoked")). One scoped-payload path for
// both transports — the strangler leaves no WS-path divergence.
//
// EMIT-IN-DEP (unlike tasks/cron, which emit via a manager event-sink): there is
// NO auth-manager event sink, so the index.ts seam owns mutate→emit. The
// InvitesDeps mutation methods (mint / mintSelf / revoke) do mutate+emit and hand
// back a status-mapped outcome; these handlers are PURE REST mappers that never
// receive liveEmit and never emit directly.
//
// ROLE SOURCE (locked with Reviewer1 — Option A): the seam resolves owner/member
// from the live user RECORD (getUserById), uniformly across the scoped list
// projection, the inviteOwnerOrSelf precondition, and the revoke branch — because
// the recipient-scoped emit is userId-keyed and must resolve the record anyway.
// invites.mint stays on the table's officeOwner guard (session identity); that
// one asymmetry is intentional and documented at the seam.
//
// LEAF over the executor + shared types. Only the injected InvitesDeps surface.

import {
  ok,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { InviteWire, UserRole } from "../../../shared/types.ts";
import type { InviteMintReq } from "../../../shared/contract-shapes.ts";

// Mint outcome: the {url, invite} the caller renders, or a status-mapped failure
// (the seam maps the auth MintErr code → 400 bad-input / 409 conflict).
type MintOutcome =
  | { ok: true; url: string; invite: InviteWire }
  | { ok: false; status: HandlerErrorStatus; error: string };

// Revoke outcome: the seam already applied the non-leak status policy (owner →
// honest 404/409; member post-precondition → uniform 403 with the precondition's
// code), so the handler maps it 1:1 without any role awareness of its own.
type RevokeOutcome =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; code: string };

export interface InvitesDeps {
  // Owner mint (officeOwner guard already enforced). createdBy is token-derived
  // in the seam; on ok the seam fans out emitInvitesList().
  mint(input: {
    username: string;
    role: UserRole;
    allowExisting: boolean;
    identity: Identity;
  }): Promise<MintOutcome>;
  // Self mint — binds to the caller's OWN record (userId/role) with
  // replacePriorForUsername; on ok the seam fans out emitInvitesList().
  mintSelf(identity: Identity): Promise<MintOutcome>;
  // Scoped list for the caller (record role): owner → all; member → own. Direct
  // reply only — NO fan-out (a pure read must never emit to other users).
  listScoped(identity: Identity): InviteWire[];
  // Revoke (precondition inviteOwnerOrSelf already passed). Owner unrestricted /
  // member own-only via the atomic scoped mutator; on ok the seam emits
  // invite_revoked (owners) + emitInvitesList().
  revoke(identity: Identity, tokenPrefix: string): Promise<RevokeOutcome>;
}

export function invitesHandlers(
  deps: InvitesDeps,
): Record<string, RouteHandler> {
  return {
    "invites.mint": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<InviteMintReq>;
      if (
        typeof body.username !== "string" ||
        body.username.trim().length === 0
      ) {
        return fail(400, "invalid_request", "username is required");
      }
      if (body.role !== "owner" && body.role !== "member") {
        return fail(400, "invalid_request", "role must be 'owner' or 'member'");
      }
      const r = await deps.mint({
        username: body.username,
        role: body.role,
        allowExisting: !!body.allowExisting,
        identity: ctx.identity,
      });
      // Spec: 200 {url, invite} (not 201) — matches the explicit slice contract.
      return r.ok
        ? ok({ url: r.url, invite: r.invite })
        : fail(r.status, "mint_failed", r.error);
    },

    "invites.mintSelf": async (ctx) => {
      const r = await deps.mintSelf(ctx.identity);
      return r.ok
        ? ok({ url: r.url, invite: r.invite })
        : fail(r.status, "mint_failed", r.error);
    },

    "invites.list": (ctx) => ok({ invites: deps.listScoped(ctx.identity) }),

    "invites.revoke": async (ctx) => {
      const r = await deps.revoke(ctx.identity, ctx.params.tokenPrefix);
      return r.ok ? noContent() : fail(r.status, r.code);
    },
  };
}
