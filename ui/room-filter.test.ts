import { describe, expect, it } from "bun:test";
import {
  appRoomId,
  effectiveRoomFilter,
  knownRoomId,
  openingRoomFilter,
  roomFilterMatches,
  roomFilterOptions,
} from "./room-filter.ts";

const rooms = [{ id: "a1a1a1a1" }, { id: "b2b2b2b2" }];

describe("room filter", () => {
  it("all lets everything through; none keeps roomless records; a room id keeps that room", () => {
    expect(roomFilterMatches("all", null)).toBe(true);
    expect(roomFilterMatches("all", "a1a1a1a1")).toBe(true);
    expect(roomFilterMatches("none", null)).toBe(true);
    expect(roomFilterMatches("none", "a1a1a1a1")).toBe(false);
    expect(roomFilterMatches("a1a1a1a1", "a1a1a1a1")).toBe(true);
    expect(roomFilterMatches("a1a1a1a1", "b2b2b2b2")).toBe(false);
    expect(roomFilterMatches("a1a1a1a1", null)).toBe(false);
  });

  it("a page opens on the room the office shows, else on all rooms", () => {
    expect(openingRoomFilter("b2b2b2b2", false, rooms)).toBe("b2b2b2b2");
    expect(openingRoomFilter("b2b2b2b2", true, rooms)).toBe("all");
    expect(openingRoomFilter(null, false, rooms)).toBe("all");
    expect(openingRoomFilter("c3c3c3c3", false, rooms)).toBe("all");
  });

  it("a room this viewer no longer has falls back to all rooms", () => {
    expect(effectiveRoomFilter("a1a1a1a1", rooms)).toBe("a1a1a1a1");
    expect(effectiveRoomFilter("c3c3c3c3", rooms)).toBe("all");
    expect(effectiveRoomFilter("none", rooms)).toBe("none");
  });

  it("a stored room that is not one of the viewer's rooms reads as no room", () => {
    expect(knownRoomId("a1a1a1a1", rooms)).toBe("a1a1a1a1");
    expect(knownRoomId("c3c3c3c3", rooms)).toBeNull();
    expect(knownRoomId(undefined, rooms)).toBeNull();
  });

  it("an app's room is its creator agent's live room, by id only", () => {
    const agents = [{ id: "agent-1", roomId: "b2b2b2b2" }];
    expect(appRoomId({ createdByAgentId: "agent-1" }, agents, rooms)).toBe(
      "b2b2b2b2",
    );
    expect(appRoomId({ createdByAgentId: "gone" }, agents, rooms)).toBeNull();
    expect(appRoomId({}, agents, rooms)).toBeNull();
  });

  it("an owner's options add the rooms hidden from their view, once each", () => {
    const options = roomFilterOptions(
      [{ id: "a1a1a1a1", name: "A" }],
      [
        { id: "a1a1a1a1", name: "A" },
        { id: "b2b2b2b2", name: "B" },
      ],
    );
    expect(options.map((room) => room.id)).toEqual(["a1a1a1a1", "b2b2b2b2"]);
  });
});
