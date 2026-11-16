// An isolated member (internal-docs/member-os-user-design.md, section 3.1 and
// slice 1a) cannot become an owner while they have an OS user: an owner sets
// office variables that reach every office-user agent. And the office does not
// remove them while they have one: a removal passes the agents to an heir that
// may run as the office user. Their OS user is turned off first, which brings
// their files and apps back; moving agents between hosts is task abdb452b.
import { afterEach, expect, it } from "bun:test";
import { rmSync } from "fs";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  getUserByName,
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

// A refusal by the store: a throw or a false return, never true.
function refused(write: () => boolean): boolean {
  try {
    return write() === false;
  } catch {
    return true;
  }
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
});

it("refuses every role write that would make an isolated member an owner", async () => {
  const srv = (server = await startTestServer());
  const owner = await srv.seedOwner("Morgan");
  await srv.seedMember("Alice");
  await srv.seedMember("Plain");
  const alice = getUserByName("Alice")!;
  recordMemberOsUser(alice.id, { name: "isomux-alice", uid: 2001 });

  const res = await srv.http("/api/users/Alice", {
    method: "PATCH",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "owner" }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(getUserByName("Alice")?.role).toBe("member");

  // The store refuses too, for every writer of a role.
  expect(refused(() => setUserRoleById(alice.id, "owner"))).toBe(true);
  expect(getUserByName("Alice")?.role).toBe("member");
  expect(refused(() => setUserRole("Alice", "owner"))).toBe(true);
  expect(getUserByName("Alice")?.role).toBe("member");
  const update = updateUserById(alice.id, { role: "owner" });
  expect(update.ok).toBe(false);
  expect(getUserByName("Alice")?.role).toBe("member");
  // Other changes to the isolated member still go through.
  expect(updateUserById(alice.id, { memberPrompt: "hi" }).ok).toBe(true);

  // A member without an OS user is promoted as before.
  const plain = await srv.http("/api/users/Plain", {
    method: "PATCH",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "owner" }),
  });
  expect(plain.status).toBe(200);
  expect(getUserByName("Plain")?.role).toBe("owner");
});

it("treats an unreadable record as isolated for the owner rule", async () => {
  const srv = (server = await startTestServer());
  await srv.seedOwner("Morgan");
  await srv.seedMember("Alice");
  const alice = getUserByName("Alice")!;
  await Bun.write(memberOsUsersPath(), "{");
  reloadMemberOsUsers();
  expect(updateUserById(alice.id, { role: "owner" }).ok).toBe(false);
  expect(getUserByName("Alice")?.role).toBe("member");
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
