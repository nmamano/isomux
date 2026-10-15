// The back room setting below the HTTP layer (task b16f1e6a): what OfficeState
// places with the setting off, the refusal to turn it off while agents sit in
// the back, and the two mappings that carry the field between memory and disk,
// including the default for a room stored before the setting existed.

import { describe, it, expect, beforeEach } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import { DESK_COUNT, deskOfBackSeat, isBackSeat } from "../../shared/desks.ts";
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
  roomId: string,
  desk?: number | null,
) =>
  state.spawn({ name, cwd: "/tmp", permissionMode: "default", desk, roomId })
    ?.agent ?? null;

function fillFront(state: OfficeState, roomId: string, prefix: string) {
  for (let d = 0; d < DESK_COUNT; d++) spawn(state, `${prefix}${d}`, roomId, d);
}

describe("a room with the back room off", () => {
  it("absent reads as off, the same as false", () => {
    for (const state of [office(), office(false)]) {
      expect(spawn(state, "N", "r1", null)).toBeNull();
      expect(spawn(state, "U", "r1")?.desk).toBe(0);
    }
  });

  it("spawn: no desk or a taken desk takes the first free front desk, and a full front refuses", () => {
    const state = office(false);
    expect(spawn(state, "A", "r1", 0)?.desk).toBe(0);
    expect(spawn(state, "B", "r1", 0)?.desk).toBe(1);
    expect(spawn(state, "C", "r1")?.desk).toBe(2);
    for (let d = 3; d < DESK_COUNT; d++) spawn(state, `F${d}`, "r1", d);
    expect(spawn(state, "X", "r1")).toBeNull();
    expect(spawn(state, "Y", "r1", 0)).toBeNull();
    expect(state.getAllAgents().some((a) => isBackSeat(a.desk))).toBe(false);
  });

  it("placeAgent: null is back_room_off, no desk takes a front desk, a full front is no_free_desk", () => {
    const state = office(false);
    const a = spawn(state, "A", "r1", 0)!;
    expect(state.placeAgent(a.id, "r1", null)).toEqual({
      ok: false,
      reason: "back_room_off",
    });
    expect(state.placeAgent(a.id, "r2", null)).toEqual({
      ok: false,
      reason: "back_room_off",
    });
    expect(state.placeAgent(a.id, "r2").ok).toBe(true);
    expect(state.getAgent(a.id)?.desk).toBe(0);
    fillFront(state, "r1", "F");
    expect(state.placeAgent(a.id, "r1")).toEqual({
      ok: false,
      reason: "no_free_desk",
    });
    expect(state.getAgent(a.id)?.roomId).toBe("r2");
  });

  it("placeAgent: a back agent moved with no desk into a room with it off takes a front desk", () => {
    const state = office(false);
    state.setRoomBackRoom("r1", true);
    const b = spawn(state, "B", "r1", null)!;
    expect(isBackSeat(b.desk)).toBe(true);
    expect(state.placeAgent(b.id, "r2").ok).toBe(true);
    expect(state.getAgent(b.id)?.desk).toBe(0);
  });
});

describe("setRoomBackRoom", () => {
  it("turns it on and off and emits room_back_room_updated", () => {
    const state = office(false);
    const seen: unknown[] = [];
    state.onChange((e) => seen.push(e));
    const on = state.setRoomBackRoom("r1", true);
    expect(on.ok).toBe(true);
    expect(state.rooms.find((r) => r.id === "r1")?.backRoom).toBe(true);
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

  it("off is refused while agents sit in the back, with their count; nothing moves", () => {
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

  it("the lobby and an unknown room are refused", () => {
    const state = office(false);
    expect(state.setRoomBackRoom("lobby", true)).toEqual({
      ok: false,
      reason: "not_supported",
    });
    expect(state.setRoomBackRoom("nope", true)).toEqual({
      ok: false,
      reason: "room_not_found",
    });
    expect(state.rooms.find((r) => r.id === "lobby")?.backRoom).toBeUndefined();
  });
});

describe("the back room setting survives a round trip through the disk", () => {
  beforeEach(() => {
    removeStateDir(STATE_ROOT);
    mkdirSync(STATE_ROOT, { recursive: true });
  });

  // Mutant: drop `backRoom` from the persistAll mapping in
  // server/agent-manager.ts.
  it("the setting written through the manager reaches agents.json", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({
        rooms: [{ id: "room-a", name: "A", prompt: null }],
      }),
      initialRooms: [],
    });
    expect(mgr.setRoomBackRoom("room-a", true).ok).toBe(true);
    expect(loadAgents().find((r) => r.id === "room-a")?.backRoom).toBe(true);
    expect(mgr.setRoomBackRoom("room-a", false).ok).toBe(true);
    expect(loadAgents().find((r) => r.id === "room-a")?.backRoom).toBe(false);
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

  // Mutants: drop `backRoom` from the loaded-rooms mapping that seeds
  // OfficeState in createProductionAgentManager, or drop its default from
  // the back agents.
  it("at boot: a stored value wins; a room stored before the setting reads as on only when it holds back agents", () => {
    const back = deskOfBackSeat({ table: 0, stool: 0 });
    const seeded: Room[] = [
      { id: "aaaa0001", name: "Old, back", prompt: null, agents: [] },
      { id: "aaaa0002", name: "Old, front", prompt: null, agents: [] },
      {
        id: "aaaa0003",
        name: "Stored on",
        prompt: null,
        backRoom: true,
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
    // The room stored before the setting has no key on disk.
    expect("backRoom" in loadAgents()[0]).toBe(false);
    const rooms = createProductionAgentManager().getRooms();
    const flag = (id: string) => rooms.find((r) => r.id === id)?.backRoom;
    expect(flag("aaaa0001")).toBe(true);
    expect(flag("aaaa0002")).toBe(false);
    expect(flag("aaaa0003")).toBe(true);
    expect(flag("aaaa0004")).toBe(false);
  });
});
