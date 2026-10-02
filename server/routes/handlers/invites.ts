// Invites resource handlers. The auth invite surface on
// the unified REST surface (opIds invites.{mint,mintRecovery,mintSelf,list,
// revoke}). An invite is a sign-in link for an EXISTING member; members are
// created by users.create. The handlers delegate to the auth core ops
// (mintInvite / revokeInviteByPrefix / revokeOutstandingInviteByPrefixForUser)
// and the recipient-scoped emit (emitInvitesList / liveEmit("invite_revoked")).
//
// EMIT-IN-DEP (unlike tasks/cron, which emit via a manager event-sink): there is
// NO auth-manager event sink, so the isomux-office.ts seam owns mutate→emit. The
// InvitesDeps mutation methods (mint / mintSelf / revoke) do mutate+emit and hand
// back a status-mapped outcome; these handlers are PURE REST mappers that never
// receive liveEmit and never emit directly.
//
// ROLE SOURCE: the seam resolves owner/member
// from the live user RECORD (getUserById), uniformly across the scoped list
// projection, the inviteOwnerOrSelf precondition, and the revoke branch - because
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
import type { InviteWire } from "../../../shared/types.ts";
import type { InviteMintReq } from "../../../shared/contract-shapes.ts";

// Mint outcome: the {url, invite} the caller renders, or a status-mapped failure
// (the seam maps the auth MintErr code: a missing member → 404).
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
  // Owner mint (officeOwner guard already enforced) - a sign-in link for an
  // EXISTING member, by stable userId (404 when missing). The seam derives
  // name/role from the record and fixes TTL/replacement; createdBy is
  // token-derived; on ok the seam fans out emitInvitesList().
  mint(userId: string, identity: Identity): Promise<MintOutcome>;
  // Self mint - binds to the caller's OWN record and replaces their prior
  // link; on ok the seam fans out emitInvitesList().
  mintSelf(identity: Identity): Promise<MintOutcome>;
  // Scoped list for the caller (record role): owner → all; member → own. Direct
  // reply only - NO fan-out (a pure read must never emit to other users).
  listScoped(identity: Identity): InviteWire[];
  // Revoke (precondition inviteOwnerOrSelf already passed). Owner unrestricted /
  // member own-only via the atomic scoped mutator; on ok the seam emits
  // invite_revoked (owners) + emitInvitesList().
  revoke(identity: Identity, tokenPrefix: string): Promise<RevokeOutcome>;
}

// Fields of the retired new-member invite body. A caller that still sends
// them gets the two-step pointer instead of a bare "userId is required".
const LEGACY_MINT_FIELDS = [
  "username",
  "label",
  "role",
  "language",
  "memberPrompt",
  "allowedRooms",
];

export function invitesHandlers(
  deps: InvitesDeps,
): Record<string, RouteHandler> {
  const mint: RouteHandler = async (ctx) => {
    const body = (
      typeof ctx.body === "object" && ctx.body !== null ? ctx.body : {}
    ) as Partial<InviteMintReq>;
    if (typeof body.userId !== "string" || body.userId.trim().length === 0) {
      const legacy = LEGACY_MINT_FIELDS.some((f) => f in body);
      return fail(
        400,
        "invalid_request",
        legacy
          ? "Invites no longer create members. Create the member with POST /api/users, then send POST /api/invites with {userId}."
          : "userId is required",
      );
    }
    const r = await deps.mint(body.userId, ctx.identity);
    // Spec: 200 {url, invite} (not 201) - matches the explicit slice contract.
    return r.ok
      ? ok({ url: r.url, invite: r.invite })
      : fail(r.status, "mint_failed", r.error);
  };
  return {
    "invites.mint": mint,
    // Permanent alias of invites.mint: deploy/install.sh and the control plane
    // call it on offices of every version.
    "invites.mintRecovery": mint,

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
