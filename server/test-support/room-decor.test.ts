// The room decor below the HTTP layer: the shared parse and merge rules, what
// OfficeState writes and emits, and the two mappings that carry the field
// between memory and disk (the same pair room-skin.test.ts guards for the
// skin: a field that misses either one looks right for a session and is gone
// after a restart).

import { describe, it, expect, beforeEach } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
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
import type { RoomWire } from "../../shared/types.ts";

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

describe("decor parse and merge", () => {
  it("accepts null, known slots and values, and null per slot", () => {
    expect(parseRoomDecorPatch(null)).toEqual({ ok: true, patch: null });
    expect(parseRoomDecorPatch({})).toEqual({ ok: true, patch: {} });
    expect(
      parseRoomDecorPatch({ walls: "clinic", pet: null, cabinet: "first-aid" }),
    ).toEqual({
      ok: true,
      patch: { walls: "clinic", pet: null, cabinet: "first-aid" },
    });
  });

  it("rejects an unknown slot, an unknown value and a non-object", () => {
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

  it("merges a patch, clears a slot on null, and stores null when empty", () => {
    expect(applyRoomDecorPatch(null, { walls: "clinic" })).toEqual({
      walls: "clinic",
    });
    expect(
      applyRoomDecorPatch({ walls: "clinic", pet: "none" }, { pet: null }),
    ).toEqual({ walls: "clinic" });
    expect(applyRoomDecorPatch({ walls: "clinic" }, { walls: null })).toBe(
      null,
    );
    expect(applyRoomDecorPatch({ walls: "clinic" }, null)).toBe(null);
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

describe("OfficeState.setRoomDecor", () => {
  it("merges, emits the whole resulting map, and clears to null", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    expect(state.setRoomDecor("room-a", { walls: "clinic" })).toEqual([
      {
        type: "room_decor_updated",
        roomId: "room-a",
        decor: { walls: "clinic" },
      },
    ]);
    expect(state.setRoomDecor("room-a", { ward: "beds" })[0]).toEqual({
      type: "room_decor_updated",
      roomId: "room-a",
      decor: { walls: "clinic", ward: "beds" },
    });
    expect(state.setRoomDecor("room-a", null)[0]).toEqual({
      type: "room_decor_updated",
      roomId: "room-a",
      decor: null,
    });
    expect(state.rooms[0].decor).toBe(null);
  });

  // Choosing a preset keeps the choices: only an explicit decor reset drops
  // them (Isomux PM ruling, 2026-10-02).
  it("leaves the decor alone when the skin changes", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    state.setRoomDecor("room-a", { pet: "none" });
    state.setRoomSkin("room-a", "hospital");
    state.setRoomSkin("room-a", "hospital");
    expect(state.rooms[0].decor).toEqual({ pet: "none" });
  });

  it("writes and emits nothing for an unknown room or the lobby", () => {
    const state = new OfficeState({ rooms: rooms("room-a") });
    state.ensureLobby();
    const before = JSON.stringify(state.rooms);
    expect(state.setRoomDecor("nope", { walls: "clinic" })).toEqual([]);
    expect(state.setRoomDecor("lobby", { walls: "clinic" })).toEqual([]);
    expect(JSON.stringify(state.rooms)).toBe(before);
  });
});

describe("the room decor survives a round trip through the disk", () => {
  beforeEach(() => {
    removeStateDir(STATE_ROOT);
    mkdirSync(STATE_ROOT, { recursive: true });
  });

  // Mutant: drop `decor` from the persistAll mapping in server/agent-manager.ts.
  it("decor set through the manager reaches agents.json", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    expect(mgr.setRoomDecor("room-a", { curtains: "tied" })).toBe("ok");
    const onDisk = loadAgents().find((r) => r.id === "room-a");
    expect(onDisk?.decor).toEqual({ curtains: "tied" });
  });

  // Mutant: drop `decor` from the loaded-rooms mapping that seeds OfficeState
  // in createProductionAgentManager.
  it("decor already in agents.json reaches the rooms at boot", () => {
    const seeded: Room[] = [
      {
        id: "aaaa0001",
        name: "Ward",
        prompt: null,
        skin: "hospital",
        decor: { pet: "shown" },
        agents: [],
      },
    ];
    saveAgents(seeded);
    expect(loadAgents().find((r) => r.id === "aaaa0001")?.decor).toEqual({
      pet: "shown",
    });
    const mgr = createProductionAgentManager();
    expect(mgr.getRooms().find((r) => r.id === "aaaa0001")?.decor).toEqual({
      pet: "shown",
    });
  });
});
