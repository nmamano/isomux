// Users resource handlers. The
// user-management surface on the unified REST surface (opIds users.{create,
// update,setAccess,delete}).
//
// users.update carries ONLY the
// record fields (name/role/avatar) via UserUpdateReq, and users.setInstructions
// the member's instructions; users.setAccess
// carries allowedRooms and PRUNE-clamps the target's existing notif/default
// against the new accessible set in ONE write. View prefs (notif/default) are
// SELF-only via view.* - owners do not set a member's personal prefs. That
// capability was removed rather than preserved through a wider SetAccessReq.
// claim_user's first-login pref migration becomes view.* PUTs.
//
// LEAF over the executor + shared types. The seam (isomux-office.ts) owns mutate→emit:
// the deps run updateUserById/deleteUser + emitUserUpdated/emitUsersList/
// presence (an access change re-projects through the users.ts access hook),
// mirroring the retired WS arms; these
// handlers stay pure REST mappers. The auth policy (selfOrOwner / officeOwner
// guards + the two delete preconditions) is enforced by the executor BEFORE the
// handler, so the deps never re-check role.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type {
  UserAdminWire,
  UserCreateReq,
  UserSelfWire,
  UserUpdateReq,
} from "../../../shared/contract-shapes.ts";
import {
  instructionsConflict,
  instructionsRes,
  parseInstructionsWrite,
  refuseOldFields,
} from "./instructions.ts";
import type { Identity } from "../../identity/index.ts";

// Outcome the seam shapes for a record edit / access change: ok → the updated
// record (UserSelfWire/UserAdminWire share the UserRecord shape; the audience
// distinction is the route guard's, not the type's), or a status-mapped failure.
type UserOutcome =
  | { ok: true; user: UserSelfWire }
  | {
      ok: false;
      status: HandlerErrorStatus;
      code: string;
      error: string;
      version?: string;
    };

type DeleteOutcome =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; code: string; error: string };

// The record fields the update core writes, by their stored names: the wire
// fields of users.update, plus the member's instructions from
// users.setInstructions.
export type UserRecordChanges = UserUpdateReq & {
  memberPrompt?: string | null;
  memberPromptVersion?: string;
};

export interface UsersDeps {
  readMemberPrompt(username: string): { memberPrompt: string | null } | null;
  // Owner creates a member (officeOwner already passed). Validates the name and
  // the room grants, creates the record with pendingSignIn, emits users_list.
  create(
    input: Omit<UserCreateReq, "instructions"> & {
      memberPrompt?: string | null;
    },
  ): Promise<
    | { ok: true; user: UserAdminWire }
    | { ok: false; status: HandlerErrorStatus; code: string; error: string }
  >;
  // Record edit (name/role/prompt/avatar). The route guard already passed. On
  // ok emits user_updated + users_list + presence.
  update(input: {
    username: string;
    changes: UserRecordChanges;
    identity: Identity;
  }): Promise<UserOutcome>;
  // Access grant (allowedRooms). officeOwner already passed. Prune-clamps the
  // target's existing notif/default against the new accessible set in one write;
  // on ok emits user_updated + users_list + full_state(target) + presence.
  setAccess(input: {
    username: string;
    allowedRooms: string[];
  }): Promise<UserOutcome>;
  // Delete (selfOrOwner + the two delete preconditions already passed). Re-checks
  // the not-last-owner record rule and the owner-session lockout with the
  // record removal (TOCTOU), then deletes + evicts the target's sessions +
  // emits users_list. Missing target is an idempotent no-op.
  // actor: the caller's display name, for the chat line of each agent the
  // member managed (they pass to the oldest office owner).
  delete(input: { username: string; actor: string }): Promise<DeleteOutcome>;
  attributionFor(identity: Identity): { createdBy: string };
}

// Reject a present-but-wrong-typed optional field with 422 BEFORE the core (the
// slice-7/8 malformed-boundary pattern): a non-string name/avatar or a value
// that is neither string nor null for the instructions would otherwise corrupt
// the record. Absent fields (undefined) are tolerated - UserUpdateReq is a
// Partial.
function malformedUserUpdate(
  body: Partial<UserUpdateReq> & { instructions?: unknown },
): string | null {
  if (
    body.role !== undefined &&
    body.role !== "member" &&
    body.role !== "owner"
  )
    return "role must be member or owner";
  if (body.name !== undefined && typeof body.name !== "string") {
    return "name must be a string";
  }
  if (body.name !== undefined && body.name.trim().length === 0) {
    return "name cannot be empty";
  }
  if (
    body.instructions !== undefined &&
    body.instructions !== null &&
    typeof body.instructions !== "string"
  ) {
    return "instructions must be a string or null";
  }
  if (body.avatarColor !== undefined && typeof body.avatarColor !== "string") {
    return "avatarColor must be a string";
  }
  if (
    body.avatarVariant !== undefined &&
    typeof body.avatarVariant !== "string"
  ) {
    return "avatarVariant must be a string";
  }
  return null;
}

export function usersHandlers(deps: UsersDeps): Record<string, RouteHandler> {
  return {
    "users.create": async (ctx) => {
      const old = refuseOldFields(ctx.body, { memberPrompt: "instructions" });
      if (old) return old;
      const body = (ctx.body ?? {}) as Partial<UserCreateReq>;
      if (typeof body.name !== "string" || body.name.trim().length === 0)
        return fail(422, "invalid_request", "name must be a non-empty string");
      if (body.role !== "member" && body.role !== "owner")
        return fail(422, "invalid_request", "role must be member or owner");
      const malformed = malformedUserUpdate(body);
      if (malformed) return fail(422, "invalid_request", malformed);
      if (
        body.allowedRooms !== undefined &&
        (!Array.isArray(body.allowedRooms) ||
          !body.allowedRooms.every((x) => typeof x === "string"))
      )
        return fail(
          422,
          "invalid_request",
          "allowedRooms must be an array of room ids",
        );
      const r = await deps.create({
        name: body.name,
        role: body.role,
        memberPrompt: body.instructions,
        avatarColor: body.avatarColor,
        avatarVariant: body.avatarVariant,
        allowedRooms: body.allowedRooms,
      });
      return r.ok ? created({ user: r.user }) : fail(r.status, r.code, r.error);
    },

    // The member's instructions. The write passes ONLY the text and its
    // version to the core, never the body: the route has no body-key check,
    // and a proxy agent's role check would read its owner's role.
    "users.readInstructions": (ctx) => {
      const prompt = deps.readMemberPrompt(ctx.params.username);
      return prompt
        ? ok(instructionsRes(prompt.memberPrompt))
        : fail(404, "not_found", "Member not found.");
    },

    "users.setInstructions": async (ctx) => {
      const input = parseInstructionsWrite(ctx.body);
      if (!input.ok) return input.result;
      const r = await deps.update({
        username: ctx.params.username,
        changes: {
          memberPrompt: input.instructions,
          memberPromptVersion: input.version,
        },
        identity: ctx.identity,
      });
      if (!r.ok)
        return r.status === 409 && r.version !== undefined
          ? instructionsConflict(r.version)
          : fail(r.status, r.code, r.error);
      return ok(instructionsRes(r.user.memberPrompt));
    },

    "users.update": async (ctx) => {
      const old = refuseOldFields(ctx.body, {
        memberPrompt: "instructions to PUT /api/users/:username/instructions",
        memberPromptVersion: "version to PUT /api/users/:username/instructions",
      });
      if (old) return old;
      const body = (ctx.body ?? {}) as Partial<UserUpdateReq>;
      const malformed = malformedUserUpdate(body);
      if (malformed) return fail(422, "invalid_request", malformed);
      const r = await deps.update({
        username: ctx.params.username,
        changes: {
          role: body.role,
          name: body.name,
          avatarColor: body.avatarColor,
          avatarVariant: body.avatarVariant,
        },
        identity: ctx.identity,
      });
      if (!r.ok)
        return fail(
          r.status,
          r.code,
          r.error,
          r.version === undefined ? undefined : { version: r.version },
        );
      return ok({ user: r.user });
    },

    "users.setAccess": async (ctx) => {
      const body = (ctx.body ?? {}) as { allowedRooms?: unknown };
      if (
        !Array.isArray(body.allowedRooms) ||
        !body.allowedRooms.every((x) => typeof x === "string")
      ) {
        return fail(
          422,
          "invalid_request",
          "allowedRooms must be an array of room ids",
        );
      }
      const r = await deps.setAccess({
        username: ctx.params.username,
        allowedRooms: body.allowedRooms,
      });
      return r.ok ? ok({ user: r.user }) : fail(r.status, r.code, r.error);
    },

    "users.delete": async (ctx) => {
      const r = await deps.delete({
        username: ctx.params.username,
        actor: deps.attributionFor(ctx.identity).createdBy,
      });
      return r.ok ? noContent() : fail(r.status, r.code, r.error);
    },
  };
}
