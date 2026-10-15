// The room filter for the turn-end sound and the pager's pushes
// (shared/notif-rooms.ts).

import { describe, it, expect } from "bun:test";
import { shouldNotifyRoom } from "./notif-rooms.ts";
import { LOBBY_ROOM_ID } from "./types.ts";

describe("shouldNotifyRoom", () => {
  it("follows the member's rooms, always covers the lobby, and never a missing room", () => {
    expect(shouldNotifyRoom("room-a", ["room-a"])).toBe(true);
    expect(shouldNotifyRoom("room-b", ["room-a"])).toBe(false);
    expect(shouldNotifyRoom(LOBBY_ROOM_ID, [])).toBe(true);
    expect(shouldNotifyRoom(null, ["room-a"])).toBe(false);
  });
});
