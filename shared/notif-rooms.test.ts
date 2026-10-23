// The room filter for the turn-end sound (shared/notif-rooms.ts).

import { describe, it, expect } from "bun:test";
import { shouldNotifyRoom } from "./notif-rooms.ts";
import { LOBBY_ROOM_ID } from "./types.ts";

describe("shouldNotifyRoom", () => {
  it("follows the member's rooms and never covers a missing room", () => {
    expect(shouldNotifyRoom("room-a", ["room-a"])).toBe(true);
    expect(shouldNotifyRoom("room-b", ["room-a"])).toBe(false);
    expect(shouldNotifyRoom(null, ["room-a"])).toBe(false);
  });

  // Nil, 2026-10-23: a member cannot turn lobby notifications off, so the
  // lobby notifies nobody, even when its id is in the member's rooms.
  it("never covers the lobby", () => {
    expect(shouldNotifyRoom(LOBBY_ROOM_ID, [])).toBe(false);
    expect(shouldNotifyRoom(LOBBY_ROOM_ID, ["room-a", LOBBY_ROOM_ID])).toBe(
      false,
    );
    // The same list still covers its ordinary room.
    expect(shouldNotifyRoom("room-a", ["room-a", LOBBY_ROOM_ID])).toBe(true);
  });
});
