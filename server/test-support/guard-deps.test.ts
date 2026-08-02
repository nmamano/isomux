// Phase 2.3 - Production GuardDeps adapter contract tests.
//
// Unit (T0, fakes): the translation logic - agentId → GLOBAL room id (not a
// dense projection), unknown agent → null, username/cronjob lookups, null-user
// access. Integration (T1, harness): the adapter built at the isomux-office.ts seam over
// the LIVE predicates agrees with today's materialized-allowedRooms ACL for an
// owner-all and a restricted member - the deferred-from-2.2 proof.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  buildProductionGuardDeps,
  type GuardDepsLiveReaders,
} from "../identity/guard-deps.ts";
import type { Identity } from "../identity/index.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { updateUserById } from "../users.ts";

function userIdentity(userId: string | null): Identity {
  return { scope: "user", userId, role: "member", capabilities: [] };
}

describe("guard-deps (unit): roomIdForAgent resolves the GLOBAL room id", () => {
  const readers: GuardDepsLiveReaders = {
    hasRoomAccessForUser: (userId, roomId) =>
      userId === "u1" && roomId === "r1",
    getAllAgents: () => [
      { id: "a1", roomId: "r1", userId: "u1" },
      { id: "a2", roomId: "r2", userId: "u2" },
      { id: "aDangling", roomId: "rGone", userId: null }, // roomId names no live room; unowned
    ],
    getRooms: () => [{ id: "r1" }, { id: "r2" }],
    // The killed list: "aDead" was spawned by u2 and is gone from the roster.
    // "a1" is LIVE and deliberately answers null here (the reader owns that
    // exclusion), so the two lookups can never both claim the same agent.
    killedAgentManagerUserId: (agentId) => (agentId === "aDead" ? "u2" : null),
    getUserByName: (name) => (name === "Nil" ? { id: "u1" } : null),
    listCronjobs: () => [
      { id: "j1", userId: "u7" },
      { id: "jNull", userId: null },
    ],
  };
  const deps = buildProductionGuardDeps(readers);

  it("returns the agent's authoritative roomId as the global room id", () => {
    expect(deps.roomIdForAgent("a1")).toBe("r1");
    expect(deps.roomIdForAgent("a2")).toBe("r2");
  });
  it("unknown agent → null (collapses with inaccessible)", () => {
    expect(deps.roomIdForAgent("ghost")).toBeNull();
  });
  it("dangling roomId (names no live room) → null", () => {
    expect(deps.roomIdForAgent("aDangling")).toBeNull();
  });
  it("hasRoomAccess delegates to hasRoomAccessForUser, false for null userId", () => {
    expect(deps.hasRoomAccess(userIdentity("u1"), "r1")).toBe(true);
    expect(deps.hasRoomAccess(userIdentity("u1"), "r2")).toBe(false);
    expect(deps.hasRoomAccess(userIdentity(null), "r1")).toBe(false);
  });
  it("userIdForUsername / cronjobCreatorUserId resolve or null out", () => {
    expect(deps.userIdForUsername("Nil")).toBe("u1");
    expect(deps.userIdForUsername("nobody")).toBeNull();
    expect(deps.cronjobCreatorUserId("j1")).toBe("u7");
    expect(deps.cronjobCreatorUserId("jNull")).toBeNull();
    expect(deps.cronjobCreatorUserId("ghost")).toBeNull();
  });
  it("agentManagerUserId resolves the agent's manager, null for unknown/unowned", () => {
    expect(deps.agentManagerUserId("a1")).toBe("u1");
    expect(deps.agentManagerUserId("a2")).toBe("u2");
    expect(deps.agentManagerUserId("aDangling")).toBeNull(); // unowned
    expect(deps.agentManagerUserId("ghost")).toBeNull(); // unknown
  });
  it("killedAgentManagerUserId reads the KILLED list, and the two lookups stay disjoint", () => {
    expect(deps.killedAgentManagerUserId("aDead")).toBe("u2");
    expect(deps.killedAgentManagerUserId("ghost")).toBeNull();
    // A live agent resolves through the roster and NOT through the killed
    // list; a dead one the other way round.
    expect(deps.killedAgentManagerUserId("a1")).toBeNull();
    expect(deps.agentManagerUserId("aDead")).toBeNull();
    expect(deps.roomIdForAgent("aDead")).toBeNull();
  });
});

describe("guard-deps (T1): the live adapter agrees with today's ACL", () => {
  let server: TestServer;
  let ownerId: string;
  let memberId: string;
  let rooms: { id: string }[];

  beforeAll(async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Owner");
    const member = await server.seedMember("Member");
    rooms = server.agentManager.getRooms();
    ownerId = server.guardDeps.userIdForUsername(owner.username)!;
    memberId = server.guardDeps.userIdForUsername(member.username)!;
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("boots with at least one room and resolves both users", () => {
    expect(rooms.length).toBeGreaterThan(0);
    expect(ownerId).toBeTruthy();
    expect(memberId).toBeTruthy();
  });

  it("owner-all: the owner has access to EVERY room (rule/materialized snapshot)", () => {
    const owner = {
      scope: "user",
      userId: ownerId,
      role: "owner",
      capabilities: [],
    } as Identity;
    for (const r of rooms) {
      expect(server.guardDeps.hasRoomAccess(owner, r.id)).toBe(true);
    }
  });

  it("restricted member: a fresh member (allowedRooms []) has access to NONE", () => {
    const member = userIdentity(memberId);
    for (const r of rooms) {
      expect(server.guardDeps.hasRoomAccess(member, r.id)).toBe(false);
    }
  });

  it("granting one room flips access for exactly that room", () => {
    const member = userIdentity(memberId);
    updateUserById(memberId, { allowedRooms: [rooms[0].id] });
    expect(server.guardDeps.hasRoomAccess(member, rooms[0].id)).toBe(true);
    if (rooms.length > 1) {
      expect(server.guardDeps.hasRoomAccess(member, rooms[1].id)).toBe(false);
    }
  });

  it("roomIdForAgent / userIdForUsername / killedAgentManagerUserId fail closed on unknowns", () => {
    expect(server.guardDeps.roomIdForAgent("nonexistent")).toBeNull();
    expect(server.guardDeps.userIdForUsername("nobody-here")).toBeNull();
    expect(server.guardDeps.killedAgentManagerUserId("nonexistent")).toBeNull();
  });
});
