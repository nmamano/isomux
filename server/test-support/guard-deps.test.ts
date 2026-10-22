// Production GuardDeps adapter contract tests (T0, fakes). The adapter's
// ordinary lookups are owned by the route tests that use the live adapter;
// this file keeps the edges no route reaches: a dangling room, a null user,
// a corrupt app registry, and the manager lookup.

import { describe, it, expect } from "bun:test";
import {
  buildProductionGuardDeps,
  type GuardDepsLiveReaders,
} from "../identity/guard-deps.ts";
import type { Identity } from "../identity/index.ts";

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
    killedAgentLastRoomId: () => null,
    cronRunVisibleTo: () => false,
    getUserByName: (name) => (name === "Nil" ? { id: "u1" } : null),
    getUserById: (userId) =>
      userId === "u-owner"
        ? { role: "owner" }
        : userId === "u1"
          ? { role: "member" }
          : null,
    listCronjobs: () => [
      { id: "j1", userId: "u7" },
      { id: "jNull", userId: null },
    ],
    listApps: () => [
      { name: "hello", userId: "u7" },
      { name: "orphan", userId: null },
    ],
    listWebhooks: () => [{ id: "wh_0000000000000001", userId: "u7" }],
  };
  const deps = buildProductionGuardDeps(readers);

  it("dangling roomId (names no live room) → null", () => {
    expect(deps.roomIdForAgent("aDangling")).toBeNull();
  });
  it("hasRoomAccess is false for a null userId", () => {
    expect(deps.hasRoomAccess(userIdentity("u1"), "r1")).toBe(true);
    expect(deps.hasRoomAccess(userIdentity(null), "r1")).toBe(false);
  });
  it("appOwnerUserId lets a corrupt registry THROW rather than answering null", () => {
    // Reading "no app has an owner" out of an unreadable registry would deny
    // every caller their own apps while looking like a permission decision.
    // The throw reaches the executor, which logs it and answers 500.
    const boom = buildProductionGuardDeps({
      ...readers,
      listApps: () => {
        throw new Error("registry_corrupt");
      },
    });
    expect(() => boom.appOwnerUserId("hello")).toThrow("registry_corrupt");
  });
  it("agentManagerUserId resolves the agent's manager, null for unknown/unowned", () => {
    expect(deps.agentManagerUserId("a1")).toBe("u1");
    expect(deps.agentManagerUserId("a2")).toBe("u2");
    expect(deps.agentManagerUserId("aDangling")).toBeNull(); // unowned
    expect(deps.agentManagerUserId("ghost")).toBeNull(); // unknown
  });
});
