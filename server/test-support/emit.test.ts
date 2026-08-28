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
import { emit, resolveRecipients, type EmitDeps } from "../events/emit.ts";
import { EVENT_REGISTRY } from "../events/registry.ts";

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

describe("emit: audience all / owners", () => {
  it("`all` reaches every session", () => {
    const { deps, delivered } = fixture();
    // `users_list` is an `all`-audience event (the task board LEFT this class
    // when it became room-scoped/recipient-scoped - see the registry).
    emit("users_list", { users: [] }, {}, deps);
    expect(delivered).toHaveLength(1);
    expect(new Set(delivered[0].recipients)).toEqual(
      new Set(["ownerA", "memberB", "memberB2", "memberC"]),
    );
  });
  it("`owners` reaches only owner sessions (auth-sensitive events don't leak)", () => {
    const { deps, delivered } = fixture();
    emit("session_revoked", { sessionPrefix: "abcd1234" }, {}, deps);
    expect(delivered[0].recipients).toEqual(["ownerA"]);
  });
});

describe("emit: room-ACL - projectionKey resolves the right room audience", () => {
  it("a hidden-room log_entry never reaches a session without access", () => {
    const { deps, delivered } = fixture();
    // a1 lives in r1; memberC (r2-only) must NOT receive it.
    emit("log_entry", { entry: { agentId: "a1" } as never }, {}, deps);
    expect(new Set(delivered[0].recipients)).toEqual(
      new Set(["ownerA", "memberB", "memberB2"]),
    );
  });
  it("an unknown agent fails closed - delivered to NOBODY (no broadcast)", () => {
    const { deps, delivered } = fixture();
    emit("log_entry", { entry: { agentId: "aGone" } as never }, {}, deps);
    expect(delivered).toHaveLength(0);
  });
  it("a valid room with zero access-holders delivers to an EMPTY set, not all", () => {
    const { deps, delivered } = fixture();
    // a3 lives in r3; nobody has r3 access.
    emit("clear_logs", { agentId: "a3" }, {}, deps);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].recipients).toEqual([]);
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

describe("emit: room-ACL delete - carried room id (computable post-mutation)", () => {
  it("agent_removed projects from its CARRIED roomId, not a live lookup", () => {
    const { deps, delivered } = fixture();
    // The agent is gone from state; roomIdForAgent would return null. The
    // carried roomId (r2) is what makes the audience computable.
    emit("agent_removed", { agentId: "a1", roomId: "r2" }, {}, deps);
    expect(new Set(delivered[0].recipients)).toEqual(
      new Set(["ownerA", "memberC"]),
    );
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

describe("emit: reserved strategies (resolveRecipients directly)", () => {
  it("audience 'none' resolves to null - never reaches transport", () => {
    const { deps } = fixture();
    const out = resolveRecipients(
      { audience: "none", projectionKey: { kind: "none" } },
      {},
      {},
      deps,
    );
    expect(out).toBeNull();
  });
  it("audience 'by-user' resolves to that user's sockets", () => {
    const { deps } = fixture();
    const out = resolveRecipients(
      { audience: "by-user", projectionKey: { kind: "userId" } },
      {},
      { userId: "uB" },
      deps,
    );
    expect(new Set((out ?? []).map((s) => s.id))).toEqual(
      new Set(["memberB", "memberB2"]),
    );
  });
});

describe("emit: every registry event resolves without throwing", () => {
  // Smoke: drive each id with a minimal payload + a ctx that satisfies
  // recipient-scoped keys, asserting emit never throws and respects fail-closed.
  it("no registry event throws on emit", () => {
    const ids = Object.keys(EVENT_REGISTRY) as (keyof typeof EVENT_REGISTRY)[];
    for (const id of ids) {
      const { deps } = fixture();
      expect(() =>
        emit(
          id,
          // A permissive payload; room-ACL events that can't derive a room
          // simply fail closed (asserted above), they don't throw.
          {
            entry: { agentId: "a1" },
            agentId: "a1",
            agent: { id: "a1", lastRoomId: "r1" },
            roomId: "r1",
            lastRoomId: "r1",
            room: { id: "r1" },
            changes: {},
          } as never,
          { connectionId: "cA", userId: "uA" },
          deps,
        ),
      ).not.toThrow();
    }
  });
});
