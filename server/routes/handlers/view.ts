// View-preference resource handlers — Phase 3b slice 4. The per-user visibility
// surface (opIds view.{setOrder,setNotifRooms,setDefaultRoom}) on the unified
// REST surface. SELF-scoped: the route table gates every op with view:manage +
// authenticated, and each handler acts on the CALLER's own userId.
//
// Phase 4 close-out removed view.get and view.setShown as callerless: the UI is
// echo-authoritative and reads view prefs from full_state (never a dedicated
// GET), and no hide-rooms affordance ever called setShown. The shown/hidden
// RECORD machinery — clampViewFields, projection filtering, the change.shown
// clamp branch — stays intact, so re-adding view.setShown is a one-line handler
// entry + table row when a hide-rooms UI lands.
//
// All three live ops delegate to the SAME core (applyViewChange in the index
// seam), so the view invariants — order deduped + filtered to accessible;
// notifRooms within effective shown; defaultRoomId within effective shown else
// null — live in exactly one place. The handler NEVER emits; the core fans out
// (projected full_state for order, user_updated for notifRooms/defaultRoomId).
//
// NO-ORACLE (Isomuxer3 Q2): handlers reject malformed body SHAPES (a non-array
// where room ids are expected), but NEVER an unknown / inaccessible /
// accessible-but-hidden room id — the core silently filters/clamps those, so a
// write is not an existence oracle.
//
// LEAF over the executor + the injected ViewDeps.

import { noContent, fail, type RouteHandler } from "../executor.ts";

export interface ViewChangeInput {
  order?: string[];
  shown?: string[];
  notifRooms?: string[];
  defaultRoomId?: string | null;
}

export interface ViewDeps {
  // Applies + clamps + persists + fans out. Returns false only if the target
  // user record vanished (rendered as 404 here).
  applyView(userId: string, change: ViewChangeInput): boolean;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export function viewHandlers(deps: ViewDeps): Record<string, RouteHandler> {
  // Set one view field from a string[] body field. Rejects only a malformed
  // SHAPE; the core silently filters unknown/inaccessible/hidden ids.
  const setIdList =
    (field: "order" | "notifRooms", code: string): RouteHandler =>
    (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user", "view is per-user");
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const value = body[field];
      if (!isStringArray(value)) {
        return fail(422, code, `${field} must be an array of room ids`);
      }
      if (!deps.applyView(userId, { [field]: value })) {
        return fail(404, "user_not_found");
      }
      return noContent();
    };

  return {
    "view.setOrder": setIdList("order", "invalid_order"),
    "view.setNotifRooms": setIdList("notifRooms", "invalid_notif_rooms"),

    "view.setDefaultRoom": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user", "view is per-user");
      const b = (ctx.body ?? {}) as { defaultRoomId?: unknown };
      // The contract carries a room id (set a default) OR null (clear it). The
      // core clamps an inaccessible / accessible-but-hidden id to null on the
      // SAME path (no oracle). Group 7 (3d.9b) folded the clear-to-null path
      // here from the retired update_user bridge; any other type is rejected.
      if (b.defaultRoomId !== null && typeof b.defaultRoomId !== "string") {
        return fail(
          422,
          "invalid_default_room",
          "defaultRoomId must be a room id string or null",
        );
      }
      if (!deps.applyView(userId, { defaultRoomId: b.defaultRoomId })) {
        return fail(404, "user_not_found");
      }
      return noContent();
    },
  };
}
