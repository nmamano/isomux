// Users resource handlers — Phase 3d slice 3d.9b (Group 7, auth surface). The
// user-management surface on the unified REST surface (opIds users.{list,update,
// setAccess,delete}).
//
// EXPAND+CUT (re-verified in Phase 1, contra the group-7 scope note): UNLIKE
// invites/sessions/access (registered in 3a), the users.* rows were table-
// declared but NEVER registered — an unauth probe of /api/users returned the
// LEGACY flat {error:"..."} shape (identical to a nonexistent path). So this
// slice BUILDS the handlers AND deletes the WS update_user/delete_user/claim_user
// cases.
//
// The update_user SPLIT (Nil-gated to OPTION A): users.update carries ONLY the
// record fields (name/env/prompt/avatar) via UserUpdateReq; users.setAccess
// carries allowedRooms and PRUNE-clamps the target's existing notif/default
// against the new accessible set in ONE write. View prefs (notif/default) are
// SELF-only via view.* — owners no longer set a member's personal prefs (the
// deliberate capability removal Nil chose over preserving it via a wider
// SetAccessReq). claim_user's first-login pref migration becomes view.* PUTs.
//
// LEAF over the executor + shared types. The seam (index.ts) owns mutate→emit:
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
  // Record edit (name/env/prompt/avatar). selfOrOwner already passed. Validates
  // envFile via the shared seam; on ok emits user_updated + users_list + presence.
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
  // Slice 3h3 boss-scoped memory curation. validateMemory checks WITHOUT writing
  // (a typo blocks the whole save). rewriteBossMemoryByUserId rewrites
  // bosses/<userId>.md — keyed by the STABLE userId (from the updated record), so
  // a rename+memory PATCH still hits the right file. author is server-derived.
  validateMemory(
    text: string,
  ): { ok: true } | { ok: false; lineNumber: number };
  rewriteBossMemoryByUserId(userId: string, text: string, author: string): void;
  attributionFor(identity: Identity): { createdBy: string };
}

// Reject a present-but-wrong-typed optional field with 422 BEFORE the core (the
// slice-7/8 malformed-boundary pattern): a non-string name/avatar or a value
// that is neither string nor null for env/prompt would otherwise corrupt the
// record. Absent fields (undefined) are tolerated — UserUpdateReq is a Partial.
function malformedUserUpdate(body: Partial<UserUpdateReq>): string | null {
  if (body.name !== undefined && typeof body.name !== "string") {
    return "name must be a string";
  }
  if (body.name !== undefined && body.name.trim().length === 0) {
    return "name cannot be empty";
  }
  if (
    body.envFile !== undefined &&
    body.envFile !== null &&
    typeof body.envFile !== "string"
  ) {
    return "envFile must be a string or null";
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
      // memory is NOT a user-record field: extract it (wrong-typed -> omitted,
      // like the other surfaces) and strip before the record-shape check + update.
      const memory = typeof body.memory === "string" ? body.memory : undefined;
      const changes = { ...body };
      delete changes.memory;
      const malformed = malformedUserUpdate(changes);
      if (malformed) return fail(422, "invalid_request", malformed);
      // Pre-validate memory so a typo blocks the WHOLE save — no record changes.
      if (memory !== undefined) {
        const v = deps.validateMemory(memory);
        if (!v.ok) {
          return fail(
            400,
            "invalid_memory_line",
            `malformed memory control line at line ${v.lineNumber}`,
            { lineNumber: v.lineNumber },
          );
        }
      }
      const r = await deps.update({
        username: ctx.params.username,
        changes,
      });
      if (!r.ok) return fail(r.status, r.code, r.error);
      // Rewrite by the updated record's STABLE id (survives a rename in this same
      // PATCH) — never re-resolve the (possibly renamed) username.
      if (memory !== undefined) {
        deps.rewriteBossMemoryByUserId(
          r.user.id,
          memory,
          deps.attributionFor(ctx.identity).createdBy,
        );
      }
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
