// Phase 3c slice 4: roomId is THE room reference — the dense AgentInfo.room index
// is gone from the wire and from OfficeState. These pin the two invariants the
// id-keyed model rests on, at the layers where they are cheaply testable:
//
//   (a) OfficeState tracks rooms purely by stable roomId across spawn / move /
//       close. The load-bearing case is the close: when a LOWER empty room
//       closes, a surviving agent's roomId is UNCHANGED and — the whole point of
//       the cut — closeRoom emits ONLY room_closed, with NO per-agent
//       agent_updated index-shift churn.
//   (b) The AgentManager room helpers fail LOUD — globalRoomIndexOf returns -1
//       and roomById returns undefined for an unknown roomId. They NEVER coerce
//       a miss to room 0, so a corrupt id surfaces as suppression/fallback at the
//       call site rather than silently relocating an agent to the lobby.
//
// The per-recipient WIRE shape (room-list filtering + id-keyed agents/presence)
// is pinned by projection.test.ts / presence.test.ts; the restore-side
// corrupt-roomId path (persisted roomId != container) is pinned by
// persistence.test.ts.

import { describe, it, expect } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";

function rooms(...ids: string[]) {
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

describe("3c.4 roomId is the room reference — OfficeState tracks rooms by id", () => {
  it("spawn stamps the target roomId", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2", "r3", "r4") });
    const a = spawnInto(ofs, "r3", "A");
    expect(a.roomId).toBe("r3");
  });

  it("close of a LOWER empty room: surviving roomId stays stable and the close emits NO per-agent churn", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2", "r3", "r4") });
    const a = spawnInto(ofs, "r3", "A");
    const events = ofs.closeRoom("r2"); // empty non-lobby room below r3
    // The agent did not move — its stable roomId is unchanged...
    expect(find(ofs, a.id).roomId).toBe("r3");
    // ...and the close emits ONLY room_closed: no dense index exists to shift, so
    // none of the pre-cut per-agent agent_updated churn fires. This is the point
    // of the id-keyed wire cut.
    expect(events).toEqual([{ type: "room_closed", roomId: "r2" }]);
  });

  it("move updates the agent's roomId", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2", "r3") });
    const a = spawnInto(ofs, "r1", "A");
    expect(a.roomId).toBe("r1");
    ofs.moveAgent(a.id, "r3");
    expect(find(ofs, a.id).roomId).toBe("r3");
  });

  it("spawn with an UNKNOWN roomId is rejected (null), never coerced to rooms[0]", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2") });
    const res = ofs.spawn({
      name: "A",
      cwd: "/tmp",
      permissionMode: "default",
      roomId: "does-not-exist",
    });
    expect(res).toBeNull();
    expect(ofs.getAllAgents().length).toBe(0); // nothing landed in r1
  });

  it('spawn with roomId "" is rejected (provided-but-unknown), not coerced and not stored dangling', () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2") });
    const res = ofs.spawn({
      name: "A",
      cwd: "/tmp",
      permissionMode: "default",
      roomId: "",
    });
    expect(res).toBeNull();
    expect(ofs.getAllAgents().length).toBe(0);
  });

  it("spawn with an OMITTED roomId still defaults to the canonical first room", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2") });
    const res = ofs.spawn({
      name: "A",
      cwd: "/tmp",
      permissionMode: "default",
    });
    expect(res?.agent.roomId).toBe("r1");
  });

  it("move to an UNKNOWN roomId is a no-op (agent stays put)", () => {
    const ofs = new OfficeState({ rooms: rooms("r1", "r2") });
    const a = spawnInto(ofs, "r1", "A");
    expect(ofs.moveAgent(a.id, "does-not-exist")).toEqual([]);
    expect(find(ofs, a.id).roomId).toBe("r1");
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
