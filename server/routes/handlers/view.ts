// View-preference resource handlers — Phase 3b slice 4. The per-user visibility
// surface (opIds view.{get,setOrder,setShown,setNotifRooms,setDefaultRoom}) on
// the unified REST surface. SELF-scoped: the route table gates every op with
// view:manage + authenticated, and each handler acts on the CALLER's own userId.
//
// Strangler EXPAND: these routes and the legacy WS arms (reorder_rooms; the
// notifRooms/defaultRoomId fields of update_user) BOTH delegate to the SAME core
// (applyViewChange / getViewProjection in the index seam), so the view
// invariants — order deduped + filtered to accessible; effective shown =
// accessible minus hidden; notifRooms within effective shown; defaultRoomId
// within effective shown else null — live in exactly one place. The handler
// NEVER emits; the core fans out (projected full_state for order/shown,
// user_updated for notifRooms/defaultRoomId).
//
// NO-ORACLE (Isomuxer3 Q2): handlers reject malformed body SHAPES (a non-array
// where room ids are expected), but NEVER an unknown / inaccessible /
// accessible-but-hidden room id — the core silently filters/clamps those, so a
// write is not an existence oracle. view.get returns the EFFECTIVE projection
// only (never a stored id the caller cannot access).
//
// LEAF over the executor + the injected ViewDeps.

import { ok, noContent, fail, type RouteHandler } from "../executor.ts";

export interface ViewProjectionWire {
  order: string[];
  shown: string[];
  notifRooms: string[];
  defaultRoomId: string | null;
}

export interface ViewChangeInput {
  order?: string[];
  shown?: string[];
  notifRooms?: string[];
  defaultRoomId?: string | null;
}

export interface ViewDeps {
  getView(userId: string): ViewProjectionWire;
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
    "view.get": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user", "view is per-user");
      return ok(deps.getView(userId));
    },

    "view.setOrder": setIdList("order", "invalid_order"),
    "view.setShown": setIdList("shown", "invalid_shown"),
    "view.setNotifRooms": setIdList("notifRooms", "invalid_notif_rooms"),

    "view.setDefaultRoom": (ctx) => {
      const userId = ctx.identity.userId;
      if (!userId) return fail(401, "not_a_user", "view is per-user");
      const b = (ctx.body ?? {}) as { defaultRoomId?: unknown };
      // The contract carries a string (set a default). The core clamps an
      // inaccessible / accessible-but-hidden id to null on the SAME path (no
      // oracle); clearing-to-null is via the legacy update_user bridge.
      if (typeof b.defaultRoomId !== "string") {
        return fail(
          422,
          "invalid_default_room",
          "defaultRoomId must be a room id string",
        );
      }
      if (!deps.applyView(userId, { defaultRoomId: b.defaultRoomId })) {
        return fail(404, "user_not_found");
      }
      return noContent();
    },
  };
}
