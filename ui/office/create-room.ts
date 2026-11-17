// Creates a room with the default name and look, and installs it in the store
// from the response. The response can come before the owner's room_created
// broadcast or the member's projected full_state, so a caller can select the
// room at once. Every door that creates a room calls this.

import type { Dispatch } from "react";
import type { RoomWire } from "../../shared/types.ts";
import { apiFetch } from "../api.ts";
import type { Action } from "../store.tsx";

export async function createRoom(
  dispatch: Dispatch<Action>,
): Promise<RoomWire> {
  // A new room opens with the default look; its look is chosen later in the
  // room's settings (Nil, 2026-09-27).
  const { room } = await apiFetch<{ room: RoomWire }>("POST", "/api/rooms", {});
  dispatch({ type: "room_created", room });
  return room;
}
