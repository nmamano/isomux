// An isolated member (internal-docs/member-os-user-design.md, section 3.1)
// may be an owner (task 12c796b2). The office does not remove a member
// while they have an OS user: a removal passes the agents to an heir that
// may run as the office user. Their OS user is turned off first, which brings
// their files and apps back; moving agents between hosts is task abdb452b.
import { afterEach, expect, it } from "bun:test";
import { rmSync } from "fs";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  deleteUserById,
  getUserByName,
  restoreUserRecord,
  setUserRole,
  setUserRoleById,
  updateUserById,
} from "../users.ts";
import {
  memberOsUsersPath,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "../member-os-users.ts";
import { managedUserEnvExists, writeManagedUserEnv } from "../user-env.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
});

// Task 12c796b2: an owner may run as their own OS user (Nil, 2026-11-20:
// "owners are privileged. that is accepted"). The residual risk is a note in
// docs/security-audit.md, not a refusal.
it("makes an isolated member an owner through the route and every store writer", async () => {
  const srv = (server = await startTestServer());
  const owner = await srv.seedOwner("Morgan");
  await srv.seedMember("Alice");
  const alice = getUserByName("Alice")!;
  recordMemberOsUser(alice.id, { name: "isomux-alice", uid: 2001 });

  const res = await srv.http("/api/users/Alice", {
    method: "PATCH",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "owner" }),
  });
  expect(res.status).toBe(200);
  expect(getUserByName("Alice")?.role).toBe("owner");

  // Each store writer of a role, from member to owner again.
  const writers: [string, () => boolean][] = [
    ["setUserRoleById", () => setUserRoleById(alice.id, "owner")],
    ["setUserRole", () => setUserRole("Alice", "owner")],
    ["updateUserById", () => updateUserById(alice.id, { role: "owner" }).ok],
  ];
  for (const [name, write] of writers) {
    expect(setUserRoleById(alice.id, "member")).toBe(true);
    expect([name, write(), getUserByName("Alice")?.role]).toEqual([
      name,
      true,
      "owner",
    ]);
  }

  // The restore of a removed owner whose OS user record outlived them (a
  // record is kept past a removal: server/member-os-users.ts).
  // The harness seeds one owner; a second one is a member made an owner.
  await srv.seedMember("Olga");
  const promoted = await srv.http("/api/users/Olga", {
    method: "PATCH",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "owner" }),
  });
  expect(promoted.status).toBe(200);
  const olga = getUserByName("Olga")!;
  expect(olga.role).toBe("owner");
  const removed = await srv.http("/api/users/Olga", {
    method: "DELETE",
    rawSessionId: owner.rawSessionId,
  });
  expect(removed.status).toBe(204);
  expect(getUserByName("Olga")).toBeUndefined();
  recordMemberOsUser(olga.id, { name: "isomux-olga", uid: 2002 });
  const restored = await srv.http(`/api/removed-members/${olga.id}/restore`, {
    method: "POST",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(restored.status).toBe(200);
  expect(getUserByName("Olga")?.role).toBe("owner");
  // The store writer the restore uses, on its own.
  const record = { ...getUserByName("Olga")! };
  expect(deleteUserById(olga.id)).toBe(true);
  expect(restoreUserRecord(record).ok).toBe(true);
  expect(getUserByName("Olga")?.role).toBe("owner");
});

it("makes a member with an unreadable record an owner", async () => {
  const srv = (server = await startTestServer());
  await srv.seedOwner("Morgan");
  await srv.seedMember("Alice");
  const alice = getUserByName("Alice")!;
  await Bun.write(memberOsUsersPath(), "{");
  reloadMemberOsUsers();
  expect(updateUserById(alice.id, { role: "owner" }).ok).toBe(true);
  expect(getUserByName("Alice")?.role).toBe("owner");
});

it("refuses to remove an isolated member, before any removal step runs", async () => {
  const srv = (server = await startTestServer());
  const owner = await srv.seedOwner("Morgan");
  await srv.seedMember("Alice");
  const alice = getUserByName("Alice")!;
  writeManagedUserEnv(alice.id, { ALICE_VAR: "1" });
  recordMemberOsUser(alice.id, { name: "isomux-alice", uid: 2001 });

  const res = await srv.http("/api/users/Alice", {
    method: "DELETE",
    rawSessionId: owner.rawSessionId,
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(getUserByName("Alice")?.id).toBe(alice.id);
  // The removal's first steps (variables, secrets, sign-ins) did not run.
  expect(managedUserEnvExists(alice.id)).toBe(true);
});
