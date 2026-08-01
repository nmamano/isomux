// Phase 3b slice 3 step E - owner-access migration coverage.
//
// Two layers, because the migration's two risks are different:
//   1. SET ARITHMETIC (the per-owner decision) - covered by direct unit tests
//      of the pure planOwnerAccessMigration(), exhaustive over the case matrix.
//   2. BOOT WIRING / ORDERING (the migration runs at boot, AFTER rooms load,
//      and PERSISTS) - covered by a real-boot restart() integration test. A
//      pure test can't catch "migration ran before rooms loaded" (which would
//      make every owner take the all-stale branch -> hidden=∅); only a cold
//      reboot against real persisted rooms + owners can.
//
// This is the security-critical slice: the boot migration MUTATES persisted
// owner records, and a restart deploys it against the real office's owners.

import { describe, it, expect, afterEach } from "bun:test";
import { planOwnerAccessMigration } from "../access-migration.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserById, getUserByName, updateUserById } from "../users.ts";
import type { UserRecord } from "../../shared/types.ts";

// Minimal valid UserRecord for planner unit tests; override the few fields the
// migration reads (id / role / allowedRooms / hidden) via the spread.
function mkUser(over: Partial<UserRecord> & { id: string }): UserRecord {
  return {
    name: over.id,
    notifRooms: [],
    envFile: null,
    createdAt: 0,
    role: "member",
    allowedRooms: [],
    hidden: [],
    order: [],
    memberPrompt: null,
    avatarColor: "#abcabc",
    avatarVariant: "classic",
    language: null,
    slideMode: false,
    ...over,
  };
}

describe("planOwnerAccessMigration (pure decision)", () => {
  it("skips members entirely (rule-based access is owner-only)", () => {
    const users = [
      mkUser({ id: "m1", role: "member", allowedRooms: ["r1"] }),
      mkUser({ id: "m2", role: "member", allowedRooms: [] }),
    ];
    expect(planOwnerAccessMigration(users, ["r1", "r2"])).toEqual([]);
  });

  it("skips an already-migrated owner (empty grants = the idempotency marker)", () => {
    const users = [mkUser({ id: "o1", role: "owner", allowedRooms: [] })];
    expect(planOwnerAccessMigration(users, ["r1", "r2"])).toEqual([]);
  });

  it("all-stale grants (cover no live room) -> hidden=∅, grants cleared (never a blank office)", () => {
    const users = [
      mkUser({
        id: "o1",
        role: "owner",
        allowedRooms: ["deleted-1", "gone-2"],
      }),
    ];
    expect(planOwnerAccessMigration(users, ["r1", "r2", "r3"])).toEqual([
      { id: "o1", hidden: [], allowedRooms: [] },
    ]);
  });

  it("partial grants -> hidden = liveRooms \\ grants (self-hidden view survives), grants cleared", () => {
    const users = [
      mkUser({ id: "o1", role: "owner", allowedRooms: ["r1", "r2"] }),
    ];
    expect(planOwnerAccessMigration(users, ["r1", "r2", "r3"])).toEqual([
      { id: "o1", hidden: ["r3"], allowedRooms: [] },
    ]);
  });

  it("full-coverage grants (the common pre-3b owner) -> hidden=∅, grants cleared", () => {
    const users = [
      mkUser({ id: "o1", role: "owner", allowedRooms: ["r1", "r2", "r3"] }),
    ];
    expect(planOwnerAccessMigration(users, ["r1", "r2", "r3"])).toEqual([
      { id: "o1", hidden: [], allowedRooms: [] },
    ]);
  });

  it("unions pre-existing hidden with the seeded complement AND prunes stale hidden ids", () => {
    // existing hidden = [r2 (live), stale (dead)]; grants = [r1] of all
    // {r1,r2,r3} -> seeded complement = [r2, r3]. Result: union ∩ live, deduped,
    // existing-first then seeded -> [r2, r3] (stale dropped, r2 not duplicated).
    const users = [
      mkUser({
        id: "o1",
        role: "owner",
        allowedRooms: ["r1"],
        hidden: ["r2", "stale"],
      }),
    ];
    expect(planOwnerAccessMigration(users, ["r1", "r2", "r3"])).toEqual([
      { id: "o1", hidden: ["r2", "r3"], allowedRooms: [] },
    ]);
  });

  it("prunes stale hidden even on the all-stale (hidden=∅-seed) branch", () => {
    // grants cover no live room -> seeded hidden = ∅; pre-existing hidden still
    // gets intersected with live, so a dead id is not carried forward.
    const users = [
      mkUser({
        id: "o1",
        role: "owner",
        allowedRooms: ["deleted"],
        hidden: ["also-dead"],
      }),
    ];
    expect(planOwnerAccessMigration(users, ["r1", "r2"])).toEqual([
      { id: "o1", hidden: [], allowedRooms: [] },
    ]);
  });

  it("processes multiple owners in one pass; members in the same set are untouched", () => {
    const users = [
      mkUser({ id: "o1", role: "owner", allowedRooms: ["r1", "r2"] }),
      mkUser({ id: "m1", role: "member", allowedRooms: ["r1"] }),
      mkUser({ id: "o2", role: "owner", allowedRooms: ["stale"] }),
    ];
    expect(planOwnerAccessMigration(users, ["r1", "r2", "r3"])).toEqual([
      { id: "o1", hidden: ["r3"], allowedRooms: [] },
      { id: "o2", hidden: [], allowedRooms: [] },
    ]);
  });
});

// --- Boot wiring / ordering / persistence (real cold reboot) ----------------

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("owner-access migration at boot (real persisted state)", () => {
  it("a persisted owner with legacy materialized grants is migrated on the next boot, and the result is idempotent across restarts", async () => {
    // boot 1: clean office. The boot migration runs against NO users (owner is
    // seeded after boot), a no-op - exactly today's harness gap this test fills.
    server = await startTestServer();
    const owner = await server.seedOwner("Boss"); // seeded grants=[] (post-3b)
    const r1 = server.agentManager.getRooms()[0].id; // default "Room 1"
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3");

    const ownerId = getUserByName(owner.username)!.id;
    // Rewrite the persisted owner into the LEGACY materialized-grants shape a
    // pre-3b office would have on disk: partial grants [r1, r2], no hidden.
    const rewrite = updateUserById(ownerId, {
      allowedRooms: [r1, r2],
      hidden: [],
    });
    expect(rewrite.ok).toBe(true);

    // Cold reboot WITHOUT wiping: boot 2 runs the migration against the real
    // persisted owner + the real persisted rooms (r1,r2,r3). This proves the
    // call-site placement (after rooms load) - if the migration ran before
    // rooms loaded, the complement would be empty and r3 would not be hidden.
    server = await server.restart();
    expect(server.agentManager.getRooms().map((r) => r.id)).toEqual([
      r1,
      r2,
      r3,
    ]);

    const migrated = getUserById(ownerId)!;
    expect(migrated.allowedRooms).toEqual([]); // grants cleared
    expect(migrated.hidden).toEqual([r3]); // complement of [r1,r2] over live set

    // boot 3: the migration is idempotent - the now-empty grants are the marker,
    // so a second restart neither re-seeds hidden nor clobbers the migrated
    // record. This also proves boot 2's result actually persisted to disk.
    server = await server.restart();
    const after = getUserById(ownerId)!;
    expect(after.allowedRooms).toEqual([]);
    expect(after.hidden).toEqual([r3]);
  });
});
