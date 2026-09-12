// Room resource handlers. The room-structure
// mutation surface (opIds rooms.{create,close,rename,setSettings}) on the
// unified REST surface, plus the read side of the settings pair
// (rooms.getSettings - same ACL as the PUT, so a writer can read the prompt
// it would overwrite). The route table gates create with room:manage +
// authenticated, and close/rename/getSettings/setSettings with room:manage +
// requiresRoomAccess(:roomId).
//
// Strangler EXPAND+CUT in one slice: 3a/3b declared these routes in the table
// but never landed a handler (the rooms surface stayed WS-only). This slice
// builds the handlers AND deletes the WS cases (create_room / close_room /
// rename_room / update_room_settings) in the same change. The COMPOUND effects
// live in the injected RoomsDeps closures (in the index seam), not here - create
// applies the rule-based creator grant + projected full_state + presence; close
// strips the dead roomId from every user record + fans out user_updated/
// users_list + presence. That matches the access/invites EMIT-IN-DEP pattern and
// keeps these handlers contract-shaped, not office-runtime-shaped.
//
// NO-ORACLE / owner-diagnostic (Follow-up #6): close/rename/setSettings return
// false from the core when the room does not exist (getSettings returns null),
// which the handler renders as
// 404 "Room not found". Under rule-based access an OWNER passes the
// requiresRoomAccess guard even for an unknown id (canAccess(owner, anyId) is
// true), so the owner reaches this 404; a MEMBER without access is denied at the
// guard (403) BEFORE existence is disclosed. That owner-vs-member distinction is
// intentional and pinned by tests.
//
// LEAF over the executor + the injected RoomsDeps.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
} from "../executor.ts";
import type { RoomWire } from "../../../shared/types.ts";
import { parseRoomPet, type RoomPet } from "../../../shared/pets.ts";
import {
  parseRoomSkin,
  type RoomSkin,
} from "../../../shared/room-skins.ts";

export interface RoomsDeps {
  // Creates a room, applies the rule-based creator grant (a member creator
  // self-grants + receives a projected full_state; owners reach it by rule),
  // refreshes presence, and returns the created room's wire shape. `name` absent
  // defaults the room name in the core.
  create(input: {
    name?: string;
    skin?: RoomSkin | null;
    creatorUserId: string | null;
  }): {
    room: RoomWire;
  };
  // Closes a room, strips the dead roomId from every user's allowedRooms/
  // notifRooms (user_updated per touched + users_list), and refreshes presence.
  // Returns false if the room does not exist (→ 404).
  close(roomId: string): boolean;
  // Renames a room. Returns false if the room does not exist (→ 404).
  rename(roomId: string, name: string): boolean;
  // Sets a room's pet; null clears it back to the default. Returns false if the
  // room does not exist (→ 404).
  setPet(roomId: string, pet: RoomPet | null): boolean;
  // Whether the room at this id takes a skin at all. Read BEFORE any value is
  // validated, so the lobby answers the same way whatever the body carries; an
  // unknown room answers "unknown" and the request runs its normal course, so
  // this never becomes an existence oracle.
  takesSkin(roomId: string): "yes" | "no" | "unknown";
  // Sets a room's skin; null clears it back to the office look. Reports which
  // of the two refusals happened, because they are different answers: an
  // unknown room is a 404, and the lobby - which draws its own scene and takes
  // no skin - is a 422.
  setSkin(
    roomId: string,
    skin: RoomSkin | null,
  ): "ok" | "room_not_found" | "skin_not_supported";
  // Reads a room's settings (the prompt; null means no prompt set) plus the
  // prompt's optimistic-concurrency version. Returns null if the room does not
  // exist (→ 404).
  getSettings(
    roomId: string,
  ): { prompt: string | null; version: string } | null;
  // Sets a room's prompt (null clears), guarded by the version from a preceding
  // getSettings - a mismatch writes nothing and reports the current version
  // (→ 409), mirroring the memory read-before-replace contract.
  setSettings(
    roomId: string,
    prompt: string | null,
    expectedVersion: string,
  ):
    | { ok: true }
    | { ok: false; reason: "room_not_found" }
    | { ok: false; reason: "version_conflict"; version: string };
}

export function roomsHandlers(deps: RoomsDeps): Record<string, RouteHandler> {
  return {
    "rooms.create": (ctx) => {
      const b = (ctx.body ?? {}) as { name?: unknown; skin?: unknown };
      const name = typeof b.name === "string" ? b.name : undefined;
      // Absent and null both create the room in the office look, so the new
      // room's record carries no skin key - the same shape every room written
      // before skins existed has.
      const parsedSkin = parseRoomSkin(b.skin);
      if (!parsedSkin.ok) return fail(422, "invalid_skin", parsedSkin.reason);
      const { room } = deps.create({
        name,
        skin: parsedSkin.skin,
        creatorUserId: ctx.identity.userId,
      });
      return created({ room });
    },

    "rooms.close": (ctx) =>
      deps.close(ctx.params.roomId)
        ? noContent()
        : fail(404, "room_not_found", "Room not found"),

    // PATCH is a PARTIAL update over three independent fields, so the old
    // `if (!name) 422` guard could not simply grow a pet branch: a body of
    // {"pet":...} is legal and carries no name, and running the rename with an
    // absent name would have renamed the room to nothing. Each field is applied
    // only when the body actually carries it.
    "rooms.rename": (ctx) => {
      const b = (ctx.body ?? {}) as {
        name?: unknown;
        pet?: unknown;
        skin?: unknown;
      };
      // The tests differ on purpose and all are right over JSON: a name is
      // absent or a string, but `pet` and `skin` carry meaning when they are
      // present AND null - that is how a client clears them - so presence is
      // the question, not the value.
      const hasName = b.name !== undefined;
      const hasPet = "pet" in b;
      const hasSkin = "skin" in b;
      // Shape checks only (never an existence oracle): a malformed body is not
      // a comment on whether the room exists.
      if (!hasName && !hasPet && !hasSkin) {
        return fail(422, "invalid_request", "name, pet or skin is required");
      }
      // The lobby's refusal is decided before any value is looked at (Nil via
      // Isomux PM, 2026-09-12), so PATCHing the lobby answers the same way
      // whatever is in the body. An unknown room falls through to the normal
      // flow and still ends at the 404 below.
      if (hasSkin && deps.takesSkin(ctx.params.roomId) === "no") {
        return fail(422, "skin_not_supported", "the lobby does not take a skin");
      }
      let name = "";
      if (hasName) {
        name = typeof b.name === "string" ? b.name.trim() : "";
        if (!name) return fail(422, "invalid_name", "name is required");
      }
      let pet: RoomPet | null = null;
      if (hasPet) {
        const parsed = parseRoomPet(b.pet);
        if (!parsed.ok) return fail(422, "invalid_pet", parsed.reason);
        pet = parsed.pet;
      }
      let skin: RoomSkin | null = null;
      if (hasSkin) {
        const parsed = parseRoomSkin(b.skin);
        if (!parsed.ok) return fail(422, "invalid_skin", parsed.reason);
        skin = parsed.skin;
      }
      // One 404 for the whole request: every write hits the same room, so the
      // first miss answers for all of them and none has run.
      if (hasName && !deps.rename(ctx.params.roomId, name)) {
        return fail(404, "room_not_found", "Room not found");
      }
      if (hasPet && !deps.setPet(ctx.params.roomId, pet)) {
        return fail(404, "room_not_found", "Room not found");
      }
      if (hasSkin) {
        const result = deps.setSkin(ctx.params.roomId, skin);
        // Kept behind the early check above: OfficeState refuses the lobby on
        // its own, and its refusal has to surface as what it is rather than as
        // a misleading 404 if it is ever reached another way.
        if (result === "skin_not_supported") {
          return fail(
            422,
            "skin_not_supported",
            "the lobby does not take a skin",
          );
        }
        if (result !== "ok") {
          return fail(404, "room_not_found", "Room not found");
        }
      }
      return noContent();
    },

    "rooms.getSettings": (ctx) => {
      const settings = deps.getSettings(ctx.params.roomId);
      return settings
        ? ok(settings)
        : fail(404, "room_not_found", "Room not found");
    },

    "rooms.setSettings": (ctx) => {
      const b = (ctx.body ?? {}) as { prompt?: unknown; version?: unknown };
      const prompt = typeof b.prompt === "string" ? b.prompt : null;
      // Version is required (shape check, never an existence oracle): the write
      // replaces the whole prompt blob, so it must carry the version from a
      // preceding GET - same rail as memory.replace.
      if (typeof b.version !== "string" || b.version.length === 0) {
        return fail(
          400,
          "invalid_version",
          "version is required (from a preceding GET of the settings)",
        );
      }
      const r = deps.setSettings(ctx.params.roomId, prompt, b.version);
      if (!r.ok) {
        if (r.reason === "version_conflict") {
          return fail(
            409,
            "version_conflict",
            "the room prompt changed since your read; re-read and retry",
            { version: r.version },
          );
        }
        return fail(404, "room_not_found", "Room not found");
      }
      return noContent();
    },
  };
}
