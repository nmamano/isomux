// Users resource handlers. The
// user-management surface on the unified REST surface (opIds users.{list,update,
// setAccess,delete}).
//
// users.update carries ONLY the
// record fields (name/env/prompt/avatar) via UserUpdateReq; users.setAccess
// carries allowedRooms and PRUNE-clamps the target's existing notif/default
// against the new accessible set in ONE write. View prefs (notif/default) are
// SELF-only via view.* - owners do not set a member's personal prefs. That
// capability was removed rather than preserved through a wider SetAccessReq.
// claim_user's first-login pref migration becomes view.* PUTs.
//
// LEAF over the executor + shared types. The seam (isomux-office.ts) owns mutate→emit:
// the deps run updateUserById/deleteUser + emitUserUpdated/emitUsersList/
// pushProjectedFullStateForUserId/presence, mirroring the retired WS arms; these
// handlers stay pure REST mappers. The auth policy (selfOrOwner / officeOwner
// guards + the two delete preconditions) is enforced by the executor BEFORE the
// handler, so the deps never re-check role.

import {
  ok,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type {
  UserSelfWire,
  UserUpdateReq,
} from "../../../shared/contract-shapes.ts";
import type { Identity } from "../../identity/index.ts";

// Outcome the seam shapes for a record edit / access change: ok → the updated
// record (UserSelfWire/UserAdminWire share the UserRecord shape; the audience
// distinction is the route guard's, not the type's), or a status-mapped failure.
type UserOutcome =
  | { ok: true; user: UserSelfWire }
  | { ok: false; status: HandlerErrorStatus; code: string; error: string };

type DeleteOutcome =
  | { ok: true }
  | { ok: false; status: HandlerErrorStatus; code: string; error: string };

export interface UsersDeps {
  // Record edit (name/prompt/avatar). selfOrOwner already passed. On ok emits
  // user_updated + users_list + presence.
  update(input: {
    username: string;
    changes: UserUpdateReq;
  }): Promise<UserOutcome>;
  // Access grant (allowedRooms). officeOwner already passed. Prune-clamps the
  // target's existing notif/default against the new accessible set in one write;
  // on ok emits user_updated + users_list + full_state(target) + presence.
  setAccess(input: {
    username: string;
    allowedRooms: string[];
  }): Promise<UserOutcome>;
  // Delete (selfOrOwner + the two delete preconditions already passed). Re-checks
  // the not-last-owner invariant atomically (TOCTOU), then deletes + evicts the
  // target's sessions + emits users_list. Missing target is an idempotent no-op.
  delete(input: { username: string }): Promise<DeleteOutcome>;
  attributionFor(identity: Identity): { createdBy: string };
}

// Reject a present-but-wrong-typed optional field with 422 BEFORE the core (the
// slice-7/8 malformed-boundary pattern): a non-string name/avatar or a value
// that is neither string nor null for the prompt would otherwise corrupt the
// record. Absent fields (undefined) are tolerated - UserUpdateReq is a Partial.
function malformedUserUpdate(body: Partial<UserUpdateReq>): string | null {
  if (body.name !== undefined && typeof body.name !== "string") {
    return "name must be a string";
  }
  if (body.name !== undefined && body.name.trim().length === 0) {
    return "name cannot be empty";
  }
  if (
    body.memberPrompt !== undefined &&
    body.memberPrompt !== null &&
    typeof body.memberPrompt !== "string"
  ) {
    return "memberPrompt must be a string or null";
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
    "users.update": async (ctx) => {
      const body = (ctx.body ?? {}) as Partial<UserUpdateReq>;
      const changes = { ...body };
      const malformed = malformedUserUpdate(changes);
      if (malformed) return fail(422, "invalid_request", malformed);
      const r = await deps.update({
        username: ctx.params.username,
        changes,
      });
      if (!r.ok) return fail(r.status, r.code, r.error);
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
      const r = await deps.delete({ username: ctx.params.username });
      return r.ok ? noContent() : fail(r.status, r.code, r.error);
    },
  };
}
