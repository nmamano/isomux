// Phase 3c slice 2: roomId is the room AUTHORITY; the dense AgentInfo.room index
// is a derived wire-compat field. These pin the two invariants the slice rests
// on, at the layers where they are cheaply testable in isolation:
//
//   (a) OfficeState keeps room + roomId consistent across spawn / move / close.
//       The load-bearing case is the close-shift: when a LOWER room closes, a
//       surviving agent's stable roomId is UNCHANGED (it did not move) while its
//       dense index is recomputed downward. That decoupling is exactly what the
//       slice-4 id-keyed wire cut eliminates.
//   (b) The AgentManager room helpers fail LOUD — globalRoomIndexOf returns -1
//       and roomById returns undefined for an unknown roomId. They NEVER coerce
//       a miss to room 0, so a corrupt id surfaces as suppression/fallback at the
//       call site rather than silently relocating an agent to the lobby.
//
// The per-recipient WIRE shape (the emitted dense index) is frozen byte-for-byte
// by projection.test.ts / presence.test.ts, which stay green through slice 2 and
// are the compatibility proof; the restore-side corrupt-roomId path (persisted
// roomId != container) is pinned by persistence.test.ts.

import { describe, it, expect } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import type { RoomWire } from "../../shared/types.ts";

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id) => ({ id, name: id, prompt: null }));
}

function spawnInto(ofs: OfficeState, roomId: string, name: string) {
  const res = ofs.spawn({
    name,
    cwd: "/tmp",
    permissionMode: "default",
    roomId,
  });
  if (!res) throw new Error(`spawn into ${roomId} failed`);
  return res.agent;
}

const find = (ofs: OfficeState, id: string) =>
  ofs.getAllAgents().find((a) => a.id === id)!;

describe("3c.2 roomId authority — OfficeState keeps room + roomId consistent", () => {
  it("spawn stamps the roomId and the matching dense index", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2", "r3", "r4") });
    const a = spawnInto(ofs, "r3", "A");
    expect(a.roomId).toBe("r3");
    expect(a.room).toBe(2); // dense index of r3
  });

  it("close of a LOWER empty room: roomId stays stable, dense index shifts down", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2", "r3", "r4") });
    const a = spawnInto(ofs, "r3", "A"); // dense 2
    ofs.closeRoom("r2"); // empty non-lobby room at dense 1
    const after = find(ofs, a.id);
    expect(after.roomId).toBe("r3"); // STABLE — the agent did not move
    expect(after.room).toBe(1); // dense recomputed 2 -> 1
  });

  it("move updates both the roomId and the derived dense index", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2", "r3") });
    const a = spawnInto(ofs, "r1", "A");
    expect(a.room).toBe(0);
    ofs.moveAgent(a.id, "r3");
    const after = find(ofs, a.id);
    expect(after.roomId).toBe("r3");
    expect(after.room).toBe(2);
  });
});

describe("3c.2 roomId authority — AgentManager room helpers never silently -> 0", () => {
  const mgr = createAgentManager({
    resolveBackend: () => new FakeBackend(),
    officeState: new OfficeState({
      rooms: rooms("room-a", "room-b", "room-c"),
    }),
    initialRooms: [],
  });

  it("globalRoomIndexOf resolves a real roomId to its global index", () => {
    expect(mgr.globalRoomIndexOf("room-a")).toBe(0);
    expect(mgr.globalRoomIndexOf("room-c")).toBe(2);
  });

  it("globalRoomIndexOf returns -1 (NOT 0) for an unknown roomId", () => {
    // Logs a loud [3c] line — that is the intended tripwire, not a failure.
    expect(mgr.globalRoomIndexOf("does-not-exist")).toBe(-1);
  });

  it("roomById resolves a real roomId and is undefined (NOT room 0) for unknown", () => {
    expect(mgr.roomById("room-b")?.id).toBe("room-b");
    expect(mgr.roomById("does-not-exist")).toBeUndefined();
  });
});
