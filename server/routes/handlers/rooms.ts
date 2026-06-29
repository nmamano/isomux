// Room resource handlers — Phase 3d slice 6 (rooms CRUD). The room-structure
// mutation surface (opIds rooms.{create,close,rename,setSettings}) on the
// unified REST surface. The route table gates create with room:manage +
// authenticated, and close/rename/setSettings with room:manage +
// requiresRoomAccess(:roomId).
//
// Strangler EXPAND+CUT in one slice: 3a/3b declared these routes in the table
// but never landed a handler (the rooms surface stayed WS-only). This slice
// builds the handlers AND deletes the WS cases (create_room / close_room /
// rename_room / update_room_settings) in the same change. The COMPOUND effects
// live in the injected RoomsDeps closures (in the index seam), not here — create
// applies the rule-based creator grant + projected full_state + presence; close
// strips the dead roomId from every user record + fans out user_updated/
// users_list + presence. That matches the access/invites EMIT-IN-DEP pattern and
// keeps these handlers contract-shaped, not office-runtime-shaped.
//
// NO-ORACLE / owner-diagnostic (Follow-up #6): close/rename/setSettings return
// false from the core when the room does not exist, which the handler renders as
// 404 "Room not found". Under rule-based access an OWNER passes the
// requiresRoomAccess guard even for an unknown id (canAccess(owner, anyId) is
// true), so the owner reaches this 404; a MEMBER without access is denied at the
// guard (403) BEFORE existence is disclosed. That owner-vs-member distinction is
// intentional and pinned by tests.
//
// LEAF over the executor + the injected RoomsDeps.

import { created, noContent, fail, type RouteHandler } from "../executor.ts";
import type { RoomWire } from "../../../shared/types.ts";

export interface RoomsDeps {
  // Creates a room, applies the rule-based creator grant (a member creator
  // self-grants + receives a projected full_state; owners reach it by rule),
  // refreshes presence, and returns the created room's wire shape. `name` absent
  // defaults the room name in the core.
  create(input: { name?: string; creatorUserId: string | null }): {
    room: RoomWire;
  };
  // Closes a room, strips the dead roomId from every user's allowedRooms/
  // notifRooms (user_updated per touched + users_list), and refreshes presence.
  // Returns false if the room does not exist (→ 404).
  close(roomId: string): boolean;
  // Renames a room. Returns false if the room does not exist (→ 404).
  rename(roomId: string, name: string): boolean;
  // Sets a room's prompt (null clears). Returns false if the room does not exist
  // (→ 404).
  setSettings(roomId: string, prompt: string | null): boolean;
}

export function roomsHandlers(deps: RoomsDeps): Record<string, RouteHandler> {
  return {
    "rooms.create": (ctx) => {
      const b = (ctx.body ?? {}) as { name?: unknown };
      const name = typeof b.name === "string" ? b.name : undefined;
      const { room } = deps.create({
        name,
        creatorUserId: ctx.identity.userId,
      });
      return created({ room });
    },

    "rooms.close": (ctx) =>
      deps.close(ctx.params.roomId)
        ? noContent()
        : fail(404, "room_not_found", "Room not found"),

    "rooms.rename": (ctx) => {
      const b = (ctx.body ?? {}) as { name?: unknown };
      const name = typeof b.name === "string" ? b.name.trim() : "";
      // Shape check only (never an existence oracle): an empty/missing name is a
      // malformed body, not a comment on whether the room exists.
      if (!name) return fail(422, "invalid_name", "name is required");
      return deps.rename(ctx.params.roomId, name)
        ? noContent()
        : fail(404, "room_not_found", "Room not found");
    },

    "rooms.setSettings": (ctx) => {
      const b = (ctx.body ?? {}) as { prompt?: unknown };
      const prompt = typeof b.prompt === "string" ? b.prompt : null;
      if (!deps.setSettings(ctx.params.roomId, prompt)) {
        return fail(404, "room_not_found", "Room not found");
      }
      return noContent();
    },
  };
}
