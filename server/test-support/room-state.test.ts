// Room state below the HTTP layer: what OfficeState writes and emits for a
// room's skin, decor and back room setting, how it places agents by stable
// room id, and the two mappings that carry each room field between memory and
// disk. A field that misses either mapping looks right for one session and is
// gone after a restart - and no route test can see that, because both sides of
// a REST round trip answer from memory. The REST contract for the same fields:
// routes-rooms-rest.test.ts and routes-back-room.test.ts. The per-recipient
// wire shape: projection.test.ts and presence.test.ts.

import { describe, it, expect, beforeEach } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import { deskOfBackSeat, isBackSeat } from "../../shared/desks.ts";
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
import {
  loadAgents,
  saveAgents,
  type PersistedAgent,
  type Room,
} from "../persistence.ts";
import { removeStateDir } from "./temp-state.ts";
import { STATE_ROOT } from "../config.ts";
import { mkdirSync } from "fs";

function rooms(...ids: string[]) {
  return ids.map((id) => ({ id, name: id, prompt: null }));
}

function office(backRoom?: boolean) {
  const state = new OfficeState();
  const flag = backRoom === undefined ? {} : { backRoom };
  state.setRooms([
    { id: "r1", name: "One", prompt: null, ...flag },
    { id: "r2", name: "Two", prompt: null, ...flag },
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

  it("setRoomBackRoom turns it on and off and emits room_back_room_updated", () => {
    const state = office(false);
    const seen: unknown[] = [];
    state.onChange((e) => seen.push(e));
    expect(state.setRoomBackRoom("r1", true).ok).toBe(true);
    expect(isBackSeat(spawn(state, "B", "r1", null)?.desk ?? -1)).toBe(true);
    expect(seen).toContainEqual({
      type: "room_back_room_updated",
      roomId: "r1",
      backRoom: true,
    });
    expect(state.setRoomBackRoom("r2", true).ok).toBe(true);
    expect(state.setRoomBackRoom("r2", false).ok).toBe(true);
    expect(state.rooms.find((r) => r.id === "r2")?.backRoom).toBe(false);
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

describe("a room with the back room off", () => {
  it("absent reads as off, the same as false", () => {
    for (const state of [office(), office(false)]) {
      expect(spawn(state, "N", "r1", null)).toBeNull();
      expect(spawn(state, "U", "r1")?.desk).toBe(0);
    }
  });

  it("a back agent moved with no desk into a room with it off takes a front desk", () => {
    const state = office(false);
    state.setRoomBackRoom("r1", true);
    const b = spawn(state, "B", "r1", null)!;
    expect(isBackSeat(b.desk)).toBe(true);
    expect(state.placeAgent(b.id, "r2").ok).toBe(true);
    expect(state.getAgent(b.id)?.desk).toBe(0);
  });

  it("off is refused while agents sit in this room's back, with their count; nothing moves", () => {
    const state = office(true);
    const b1 = spawn(state, "B1", "r1", null)!;
    const b2 = spawn(state, "B2", "r1", null)!;
    spawn(state, "F", "r1", 0);
    // A back agent in another room does not count.
    spawn(state, "Other", "r2", null);
    const seen: unknown[] = [];
    state.onChange((e) => seen.push(e));
    expect(state.setRoomBackRoom("r1", false)).toEqual({
      ok: false,
      reason: "in_use",
      count: 2,
    });
    expect(seen).toEqual([]);
    expect(state.rooms.find((r) => r.id === "r1")?.backRoom).toBe(true);
    expect(state.getAgent(b1.id)?.desk).toBe(b1.desk);
    expect(state.getAgent(b2.id)?.desk).toBe(b2.desk);
    // Moved out, the setting turns off.
    expect(state.placeAgent(b1.id, "r1", 1).ok).toBe(true);
    expect(state.placeAgent(b2.id, "r1", 2).ok).toBe(true);
    expect(state.setRoomBackRoom("r1", false).ok).toBe(true);
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

  // Mutants: drop `skin`, `decor` or `backRoom` from the persistAll mapping in
  // server/agent-manager.ts.
  it("skin, decor and the back room setting written through the manager reach agents.json", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    const onDisk = () => loadAgents().find((r) => r.id === "room-a");
    expect(mgr.setRoomSkin("room-a", "hospital")).toBe("ok");
    expect(mgr.setRoomDecor("room-a", { curtains: "tied" })).toBe("ok");
    expect(mgr.setRoomBackRoom("room-a", true).ok).toBe(true);
    expect(onDisk()).toMatchObject({
      skin: "hospital",
      decor: { curtains: "tied" },
      backRoom: true,
    });
    expect(mgr.setRoomBackRoom("room-a", false).ok).toBe(true);
    expect(onDisk()?.backRoom).toBe(false);
  });

  function agentAt(id: string, desk: number): PersistedAgent {
    return {
      id,
      name: id,
      desk,
      cwd: "/tmp",
      outfit: undefined as unknown as PersistedAgent["outfit"],
      permissionMode: "default",
      lastSessionId: null,
      topic: null,
      customInstructions: null,
    };
  }

  // Mutants: drop `skin`, `decor` or `backRoom` from the loaded-rooms mapping
  // that seeds OfficeState in createProductionAgentManager, or drop the back
  // room default for a room that holds back agents.
  it("at boot: stored fields reach the rooms; a room stored before the back room setting reads as on only when it holds back agents", () => {
    const back = deskOfBackSeat({ table: 0, stool: 0 });
    const seeded: Room[] = [
      { id: "aaaa0001", name: "Old, back", prompt: null, agents: [] },
      { id: "aaaa0002", name: "Old, front", prompt: null, agents: [] },
      {
        id: "aaaa0003",
        name: "Stored on",
        prompt: null,
        backRoom: true,
        skin: "hospital",
        decor: { pet: "shown" },
        agents: [],
      },
      {
        id: "aaaa0004",
        name: "Stored off",
        prompt: null,
        backRoom: false,
        agents: [],
      },
    ];
    seeded[0].agents.push(agentAt("agent-b", back), agentAt("agent-f", 0));
    seeded[1].agents.push(agentAt("agent-g", 0));
    saveAgents(seeded);
    // The rooms stored before the setting have no key on disk.
    expect("backRoom" in loadAgents()[0]).toBe(false);
    expect(loadAgents()[2]).toMatchObject({
      skin: "hospital",
      decor: { pet: "shown" },
    });
    const loaded = createProductionAgentManager().getRooms();
    const room = (id: string) => loaded.find((r) => r.id === id);
    expect(room("aaaa0001")?.backRoom).toBe(true);
    expect(room("aaaa0002")?.backRoom).toBe(false);
    expect(room("aaaa0003")).toMatchObject({
      backRoom: true,
      skin: "hospital",
      decor: { pet: "shown" },
    });
    expect(room("aaaa0004")?.backRoom).toBe(false);
  });
});
