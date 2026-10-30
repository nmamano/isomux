// Room state below the HTTP layer: what OfficeState writes and emits for a
// room's skin and decor, how it places agents by stable
// room id, and the two mappings that carry each room field between memory and
// disk. A field that misses either mapping looks right for one session and is
// gone after a restart - and no route test can see that, because both sides of
// a REST round trip answer from memory. The REST contract for the same fields:
// routes-rooms-rest.test.ts and routes-back-room.test.ts. The per-recipient
// wire shape: projection.test.ts and presence.test.ts.

import { describe, it, expect, beforeEach } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import { DESK_COUNT, isBackSeat } from "../../shared/desks.ts";
import {
  applyRoomDecorPatch,
  parseRoomDecorPatch,
  storedRoomDecor,
} from "../../shared/room-decor.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  createAgentManager,
  createProductionAgentManager,
} from "../agent-manager.ts";
import { loadAgents, saveAgents, type Room } from "../persistence.ts";
import { removeStateDir } from "./temp-state.ts";
import { STATE_ROOT } from "../config.ts";
import { mkdirSync } from "fs";

function rooms(...ids: string[]) {
  return ids.map((id) => ({ id, name: id, prompt: null }));
}

function office() {
  const state = new OfficeState();
  state.setRooms([
    { id: "r1", name: "One", prompt: null },
    { id: "r2", name: "Two", prompt: null },
    { id: "lobby", name: "Lobby", prompt: null, type: "lobby" },
  ]);
  return state;
}

const spawn = (
  state: OfficeState,
  name: string,
  roomId?: string,
  desk?: number | null,
) =>
  state.spawn({ name, cwd: "/tmp", permissionMode: "default", desk, roomId })
    ?.agent ?? null;

const roomOf = (state: OfficeState, id: string) =>
  state.getAllAgents().find((a) => a.id === id)?.roomId;

describe("the events OfficeState emits for a room field", () => {
  it("setRoomSkin writes the skin and emits room_skin_updated", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    expect(state.setRoomSkin("room-a", "hospital")).toEqual([
      { type: "room_skin_updated", roomId: "room-a", skin: "hospital" },
    ]);
    expect(state.rooms[0].skin).toBe("hospital");
    expect(state.setRoomSkin("room-a", null)).toEqual([
      { type: "room_skin_updated", roomId: "room-a", skin: null },
    ]);
    expect(state.rooms[0].skin).toBe(null);
  });

  it("setRoomDecor merges, emits the whole resulting map, and clears to null", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    expect(state.setRoomDecor("room-a", { walls: "clinic" })).toEqual([
      {
        type: "room_decor_updated",
        roomId: "room-a",
        decor: { walls: "clinic" },
      },
    ]);
    expect(state.setRoomDecor("room-a", { ward: "beds" })).toEqual([
      {
        type: "room_decor_updated",
        roomId: "room-a",
        decor: { walls: "clinic", ward: "beds" },
      },
    ]);
    expect(state.setRoomDecor("room-a", null)).toEqual([
      { type: "room_decor_updated", roomId: "room-a", decor: null },
    ]);
    expect(state.rooms[0].decor).toBe(null);
  });
});

describe("decor values", () => {
  it("a patch with an unknown slot, an unknown value or a non-object is refused", () => {
    for (const bad of [
      { lamp: "on" },
      { walls: "pink" },
      { walls: 1 },
      { curtains: "" },
      [],
      "clinic",
      7,
      undefined,
    ]) {
      expect(parseRoomDecorPatch(bad).ok).toBe(false);
    }
  });

  // Nothing parses decor when a room is loaded from disk: a rollback or a hand
  // edit can put anything there, and the merge and the draw side drop it.
  it("drops stored slots and values this build does not know", () => {
    expect(
      storedRoomDecor({ walls: "clinic", lamp: "on", trim: "gold" }),
    ).toEqual({ walls: "clinic" });
    expect(storedRoomDecor("junk")).toEqual({});
    expect(applyRoomDecorPatch({ lamp: "on" }, { trim: "rail" })).toEqual({
      trim: "rail",
    });
  });
});

// Every room but the lobby has a back room, with no setting (task e2fb9fa0).
// Mutant: hasBackRoom as it was (only with backRoom true).
describe("every room has a back room", () => {
  it("null takes a back seat; no desk takes a front desk, then a back seat once the front is full", () => {
    const state = office();
    expect(isBackSeat(spawn(state, "N", "r1", null)?.desk ?? -1)).toBe(true);
    for (let d = 0; d < DESK_COUNT; d++)
      expect(spawn(state, `F${d}`, "r1")?.desk).toBe(d);
    expect(isBackSeat(spawn(state, "Over", "r1")?.desk ?? -1)).toBe(true);
    // The lobby still has none.
    expect(spawn(state, "L", "lobby", null)).toBeNull();
  });

  it("a back agent moved with no desk keeps its area: a back seat in the other room", () => {
    const state = office();
    const b = spawn(state, "B", "r1", null)!;
    expect(isBackSeat(b.desk)).toBe(true);
    expect(state.placeAgent(b.id, "r2").ok).toBe(true);
    expect(state.getAgent(b.id)?.roomId).toBe("r2");
    expect(isBackSeat(state.getAgent(b.id)?.desk ?? -1)).toBe(true);
  });
});

// roomId is the room reference: there is no dense room index on the wire or in
// OfficeState, and a miss never falls back to the first room.
describe("rooms by stable id", () => {
  it("closing a lower empty room leaves a survivor's roomId alone and emits only room_closed", () => {
    const state = new OfficeState({ rooms: rooms("r1", "r2", "r3", "r4") });
    const a = spawn(state, "A", "r3")!;
    expect(state.closeRoom("r2")).toEqual([
      { type: "room_closed", roomId: "r2" },
    ]);
    expect(roomOf(state, a.id)).toBe("r3");
  });

  it("spawn: an omitted roomId takes the first room; an unknown or empty one lands nowhere", () => {
    const state = new OfficeState({ rooms: rooms("r1", "r2") });
    for (const roomId of ["does-not-exist", ""]) {
      expect(spawn(state, `A${roomId}`, roomId)).toBeNull();
    }
    expect(state.getAllAgents()).toHaveLength(0);
    expect(spawn(state, "A")?.roomId).toBe("r1");
  });

  it("move: a known room updates roomId; an unknown one is a no-op", () => {
    const state = new OfficeState({ rooms: rooms("r1", "r2") });
    const a = spawn(state, "A", "r1")!;
    expect(state.moveAgent(a.id, "does-not-exist")).toEqual([]);
    expect(roomOf(state, a.id)).toBe("r1");
    state.moveAgent(a.id, "r2");
    expect(roomOf(state, a.id)).toBe("r2");
  });

  it("the AgentManager room helpers resolve a real id and miss with -1 and undefined, never room 0", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({
        rooms: rooms("room-a", "room-b", "room-c"),
      }),
      initialRooms: [],
    });
    expect(mgr.globalRoomIndexOf("room-c")).toBe(2);
    expect(mgr.roomById("room-b")?.id).toBe("room-b");
    // Logs a loud [3c] line - that is the intended tripwire, not a failure.
    expect(mgr.globalRoomIndexOf("does-not-exist")).toBe(-1);
    expect(mgr.roomById("does-not-exist")).toBeUndefined();
  });
});

describe("room fields survive a round trip through the disk", () => {
  beforeEach(() => {
    removeStateDir(STATE_ROOT);
    mkdirSync(STATE_ROOT, { recursive: true });
  });

  // Mutants: drop `skin` or `decor` from the persistAll mapping in
  // server/agent-manager.ts, or keep writing `backRoom` there.
  it("skin and decor written through the manager reach agents.json, and no backRoom key does", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    const onDisk = () => loadAgents().find((r) => r.id === "room-a");
    expect(mgr.setRoomSkin("room-a", "hospital")).toBe("ok");
    expect(mgr.setRoomDecor("room-a", { curtains: "tied" })).toBe("ok");
    expect(onDisk()).toMatchObject({
      skin: "hospital",
      decor: { curtains: "tied" },
    });
    expect("backRoom" in (onDisk() ?? {})).toBe(false);
  });

  // Mutants: drop `skin` or `decor` from the loaded-rooms mapping that seeds
  // OfficeState in createProductionAgentManager; keep a stored `backRoom` on
  // the loaded room; let hasBackRoom read a stored false; write `backRoom` in
  // persistAll.
  it("at boot: stored fields reach the rooms, and a stored backRoom (false, true or none) is dropped: every room has a back room", () => {
    const seeded: Room[] = [
      { id: "aaaa0001", name: "Old", prompt: null, agents: [] },
      {
        id: "aaaa0002",
        name: "Stored on",
        prompt: null,
        backRoom: true,
        skin: "hospital",
        decor: { pet: "shown" },
        agents: [],
      },
      {
        id: "aaaa0003",
        name: "Stored off",
        prompt: null,
        backRoom: false,
        agents: [],
      },
    ] as Room[];
    saveAgents(seeded);
    const mgr = createProductionAgentManager();
    const room = (id: string) => mgr.getRooms().find((r) => r.id === id);
    expect(room("aaaa0002")).toMatchObject({
      skin: "hospital",
      decor: { pet: "shown" },
    });
    // Placement reads the loaded rooms as they are: each takes a back seat.
    const state = new OfficeState({ rooms: mgr.getRooms() });
    for (const r of seeded) {
      expect("backRoom" in (room(r.id) ?? {})).toBe(false);
      expect(
        isBackSeat(spawn(state, `B-${r.id}`, r.id, null)?.desk ?? -1),
      ).toBe(true);
    }
    // The next write carries no backRoom for any room.
    expect(mgr.setRoomSkin("aaaa0001", "hospital")).toBe("ok");
    expect(loadAgents().filter((r) => "backRoom" in r)).toEqual([]);
  });
});
