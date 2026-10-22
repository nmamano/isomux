// Phase 2.3 - emit helper contract tests (TDD red→green for NEW code).
//
// Proves projectionKey is EXECUTABLE, not decorative: the registry's declared
// audience + projectionKey drive the actual recipient set, asserted against a
// fake transport that records who would receive each event. This is the
// behavioral half of the Reviewer4 audience gate - a mis-declared audience or a
// delete/move event that forgot its carried room id is caught here. FAIL CLOSED
// is asserted everywhere: a missing subject reaches NOBODY, never a broadcast.
//
// Pure T0: no server, no FS, no LLM.

import { describe, it, expect } from "bun:test";
import { emit, type EmitDeps } from "../events/emit.ts";

interface FakeSession {
  id: string;
  userId: string;
  role: "owner" | "member";
  connectionId: string;
  access: Set<string>;
}

function makeDeps(
  sessions: FakeSession[],
  roomForAgent: Record<string, string | null> = {},
) {
  const delivered: { id: string; recipients: string[] }[] = [];
  const deps: EmitDeps<FakeSession> = {
    sessionsForApiToken: () => [],
    allSessions: () => sessions,
    ownerSessions: () => sessions.filter((s) => s.role === "owner"),
    sessionsForUser: (uid) => sessions.filter((s) => s.userId === uid),
    sessionByConnectionId: (cid) =>
      sessions.find((s) => s.connectionId === cid) ?? null,
    sessionsForRoomAccess: (roomIds) =>
      sessions.filter((s) => roomIds.some((r) => s.access.has(r))),
    roomIdForAgent: (aid) =>
      Object.prototype.hasOwnProperty.call(roomForAgent, aid)
        ? roomForAgent[aid]
        : null,
    deliver: (recipients, id) =>
      delivered.push({ id, recipients: recipients.map((s) => s.id) }),
  };
  return { deps, delivered };
}

// A fixed cast: owner (all rooms), two members in disjoint rooms, plus a second
// socket for memberB's user (to prove userId fan-out covers every socket).
function fixture() {
  const sessions: FakeSession[] = [
    {
      id: "ownerA",
      userId: "uA",
      role: "owner",
      connectionId: "cA",
      access: new Set(["r1", "r2"]),
    },
    {
      id: "memberB",
      userId: "uB",
      role: "member",
      connectionId: "cB",
      access: new Set(["r1"]),
    },
    {
      id: "memberB2",
      userId: "uB",
      role: "member",
      connectionId: "cB2",
      access: new Set(["r1"]),
    },
    {
      id: "memberC",
      userId: "uC",
      role: "member",
      connectionId: "cC",
      access: new Set(["r2"]),
    },
  ];
  return makeDeps(sessions, { a1: "r1", a2: "r2", a3: "r3", aGone: null });
}

describe("emit: room-ACL - projectionKey resolves the right room audience", () => {
  it("a log_entry reaches only its room's sessions, and an unknown agent's reaches nobody", () => {
    const { deps, delivered } = fixture();
    // a1 lives in r1; memberC (r2-only) must NOT receive it.
    emit("log_entry", { entry: { agentId: "a1" } as never }, {}, deps);
    expect(new Set(delivered[0].recipients)).toEqual(
      new Set(["ownerA", "memberB", "memberB2"]),
    );
    // An unknown agent fails closed - no broadcast.
    emit("log_entry", { entry: { agentId: "aGone" } as never }, {}, deps);
    expect(delivered).toHaveLength(1);
  });
});

describe("emit: room-ACL move - old ∪ new rooms, both carried", () => {
  it("a move projects to the UNION of departing and arriving rooms", () => {
    const { deps, delivered } = fixture();
    emit(
      "agent_updated",
      { agentId: "a1", changes: { oldRoomId: "r1", newRoomId: "r2" } },
      {},
      deps,
    );
    expect(new Set(delivered[0].recipients)).toEqual(
      new Set(["ownerA", "memberB", "memberB2", "memberC"]),
    );
  });
  it("a non-move update falls back to the agent's CURRENT room", () => {
    const { deps, delivered } = fixture();
    emit("agent_updated", { agentId: "a1", changes: { topic: "x" } }, {}, deps);
    expect(new Set(delivered[0].recipients)).toEqual(
      new Set(["ownerA", "memberB", "memberB2"]),
    );
  });
  it("a HALF-carried move (only oldRoomId) fails closed - nobody", () => {
    const { deps, delivered } = fixture();
    emit(
      "agent_updated",
      { agentId: "a1", changes: { oldRoomId: "r1" } },
      {},
      deps,
    );
    expect(delivered).toHaveLength(0);
  });
});

describe("emit: recipient-scoped - concrete key required, no fanout fallback", () => {
  it("connectionId targets exactly one socket", () => {
    const { deps, delivered } = fixture();
    emit(
      "session_context",
      { context: {} as never },
      { connectionId: "cB" },
      deps,
    );
    expect(delivered[0].recipients).toEqual(["memberB"]);
  });
  it("a missing connectionId fails closed - never broadcasts", () => {
    const { deps, delivered } = fixture();
    emit("session_context", { context: {} as never }, {}, deps);
    expect(delivered).toHaveLength(0);
  });
  it("a stale connectionId (socket gone) delivers to EMPTY, never all", () => {
    const { deps, delivered } = fixture();
    emit(
      "editor_external_change",
      { agentId: "a1", path: "/x", mtime: 1, rev: 1 },
      { connectionId: "cGone" },
      deps,
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].recipients).toEqual([]);
  });
  it("userId fan-out reaches EVERY socket of that user", () => {
    const { deps, delivered } = fixture();
    emit(
      "full_state",
      {
        agents: [],
        recentCwds: [],
        office: {} as never,
        rooms: [],
        killedAgents: [],
        interactions: [],
      },
      { userId: "uB" },
      deps,
    );
    expect(new Set(delivered[0].recipients)).toEqual(
      new Set(["memberB", "memberB2"]),
    );
  });
  it("a missing userId fails closed - never broadcasts", () => {
    const { deps, delivered } = fixture();
    emit(
      "full_state",
      {
        agents: [],
        recentCwds: [],
        office: {} as never,
        rooms: [],
        killedAgents: [],
        interactions: [],
      },
      {},
      deps,
    );
    expect(delivered).toHaveLength(0);
  });
});
