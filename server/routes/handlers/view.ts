// View-preference resource handlers — Phase 3b slice 4. The per-user visibility
// surface (opIds view.{setOrder,setShown,setNotifRooms,listRooms}) on the
// unified REST surface. SELF-scoped: the route table gates every op with
// view:manage + authenticated, and each handler acts on the CALLER's own userId.
//
// Phase 4 close-out removed view.get and view.setShown as callerless (the UI is
// echo-authoritative and reads view prefs from full_state). Task 9301d0f4
// restored view.setShown when the hide-rooms UI landed on the Users page — the
// shown/hidden RECORD machinery (clampViewFields, projection filtering, the
// change.shown clamp branch) had been kept intact for exactly that. view.get
// stays retired. The Default Room setting (view.setDefaultRoom) was likewise
// removed — superseded by reload view-restore, which reopens the last room on
// reload; the initial room now falls back to the first visible one.
//
// view.listRooms (task 9301d0f4) is the read that makes re-SHOW possible for
// members: the projected full_state rooms exclude hidden rooms, and members
// don't receive the owner-only all_rooms_list, so without this a member who
// hid a room could never see its name again to un-hide it. It returns id+name
// for every room the CALLER can access (no leak — access is the gate the
// projection itself uses; hidden is a view preference, not a restriction).
//
// The write ops delegate to the SAME core (applyViewChange in the index seam),
// so the view invariants — order deduped + filtered to accessible; hidden =
// accessible minus shown; notifRooms within effective shown — live in exactly
// one place. The handler NEVER emits; the core fans out (projected full_state
// for order/shown, user_updated for notifRooms).
//
// NO-ORACLE (Isomuxer3 Q2): handlers reject malformed body SHAPES (a non-array
// where room ids are expected), but NEVER an unknown / inaccessible /
// accessible-but-hidden room id — the core silently filters/clamps those, so a
// write is not an existence oracle.
//
// LEAF over the executor + the injected ViewDeps.

import { ok, noContent, fail, type RouteHandler } from "../executor.ts";
import type { AccessibleRoomWire } from "../../../shared/contract-shapes.ts";

export interface ViewChangeInput {
  order?: string[];
  shown?: string[];
  notifRooms?: string[];
}

export interface ViewDeps {
  // Applies + clamps + persists + fans out. Returns false only if the target
  // user record vanished (rendered as 404 here).
  applyView(userId: string, change: ViewChangeInput): boolean;
  // Every room the user can ACCESS (hidden ones included), in office order.
  // null only if the user record vanished (rendered as 404 here).
  listAccessibleRooms(userId: string): AccessibleRoomWire[] | null;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export function viewHandlers(deps: ViewDeps): Record<string, RouteHandler> {
  // Set one view field from a string[] body field. Rejects only a malformed
  // SHAPE; the core silently filters unknown/inaccessible/hidden ids.
  const setIdList =
    (field: "order" | "shown" | "notifRooms", code: string): RouteHandler =>
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
    "view.setShown": setIdList("shown", "invalid_shown"),
    "view.setNotifRooms": setIdList("notifRooms", "invalid_notif_rooms"),

    "view.listRooms": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user", "view is per-user");
      const rooms = deps.listAccessibleRooms(userId);
      if (rooms === null) return fail(404, "user_not_found");
      return ok({ rooms });
    },
  };
}
