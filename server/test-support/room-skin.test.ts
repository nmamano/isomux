// The room skin below the HTTP layer: what OfficeState writes and emits, and
// the two mappings that carry the field between memory and disk.
//
// Those two mappings are the reason this file exists. A skin that reaches the
// store but not agents.json, or agents.json but not the store at boot, looks
// perfect for one session and is gone after a restart - and no route test can
// see that, because both sides of the round trip answer from memory. The two
// cases at the bottom fail if either mapping is dropped.

import { describe, it, expect, beforeEach } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  createAgentManager,
  createProductionAgentManager,
} from "../agent-manager.ts";
import { loadAgents, saveAgents, type Room } from "../persistence.ts";
import { removeStateDir } from "./temp-state.ts";
import { STATE_ROOT } from "../config.ts";
import { mkdirSync } from "fs";
import type { RoomWire } from "../../shared/types.ts";

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

describe("OfficeState.setRoomSkin", () => {
  it("writes the skin and emits room_skin_updated", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    const events = state.setRoomSkin("room-a", "hospital");
    expect(events).toEqual([
      { type: "room_skin_updated", roomId: "room-a", skin: "hospital" },
    ]);
    expect(state.rooms[0].skin).toBe("hospital");
    expect(state.setRoomSkin("room-a", null)[0]).toEqual({
      type: "room_skin_updated",
      roomId: "room-a",
      skin: null,
    });
    expect(state.rooms[0].skin).toBe(null);
  });

  it("writes and emits nothing for a room that does not exist", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    const before = JSON.stringify(state.rooms);
    expect(state.setRoomSkin("nope", "hospital")).toEqual([]);
    expect(JSON.stringify(state.rooms)).toBe(before);
  });

  // The lobby draws its own scene, so the field has nowhere to go there. The
  // route turns this refusal into its own answer; the state just refuses.
  it("writes and emits nothing for the lobby", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    state.ensureLobby();
    expect(state.setRoomSkin("lobby", "hospital")).toEqual([]);
    expect(state.rooms.find((r) => r.id === "lobby")?.skin ?? null).toBe(null);
  });
});

describe("OfficeState.createRoom", () => {
  it("carries the chosen skin on the created room", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    const [event] = state.createRoom("Ward", "hospital");
    expect(event.type).toBe("room_created");
    expect(
      event.type === "room_created" ? event.room.skin : undefined,
    ).toBe("hospital");
  });

  // An absent skin leaves the field off the record rather than writing
  // "office" into it, so a room created today looks like one created before
  // skins existed.
  it("leaves the field absent when no skin is asked for", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    const [event] = state.createRoom("Plain");
    expect(event.type === "room_created" && "skin" in event.room).toBe(false);
  });
});

describe("the room skin survives a round trip through the disk", () => {
  beforeEach(() => {
    removeStateDir(STATE_ROOT);
    mkdirSync(STATE_ROOT, { recursive: true });
  });

  // Mutant: drop `skin` from the persistAll mapping in server/agent-manager.ts.
  it("a skin set through the manager reaches agents.json", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    expect(mgr.setRoomSkin("room-a", "hospital")).toBe("ok");
    const onDisk = loadAgents().find((r) => r.id === "room-a");
    expect(onDisk?.skin).toBe("hospital");
  });

  // Mutant: drop `skin` from the loaded-rooms mapping that seeds OfficeState in
  // createProductionAgentManager.
  it("a skin already in agents.json reaches the rooms at boot", () => {
    const seeded: Room[] = [
      { id: "aaaa0001", name: "Ward", prompt: null, skin: "hospital", agents: [] },
    ];
    // The fixture has to carry the skin before the save, or the assertion after
    // the load proves nothing.
    expect(seeded[0].skin).toBe("hospital");
    saveAgents(seeded);
    expect(loadAgents().find((r) => r.id === "aaaa0001")?.skin).toBe(
      "hospital",
    );
    const mgr = createProductionAgentManager();
    expect(mgr.getRooms().find((r) => r.id === "aaaa0001")?.skin).toBe(
      "hospital",
    );
  });
});
