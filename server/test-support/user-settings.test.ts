// Phase 3d slice 9b — the notifRooms clamp, re-homed onto the REST split
// (Option A, Nil-gated). Setting one's OWN notifRooms goes through the SELF-ONLY
// view.* routes (clamped to the caller's accessible rooms by the shared
// applyViewChange core); an owner changing a member's allowedRooms goes through
// users.setAccess, which PRUNE-clamps the member's existing notifRooms to the new
// access in ONE write (the clamp deferred from slice 6). The old WS update_user
// (an owner setting a member's notif in one command) is retired — notifRooms is
// self-only now. Asserts the PERSISTED record so it is robust across the slice-5
// user-wire projection change. (The Default Room setting was later removed, so
// the former defaultRoom clamp cases are gone.)

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName, getUserById, updateUserById } from "../users.ts";
import type { UserRecord } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function http(
  srv: TestServer,
  rawSessionId: string,
  method: string,
  path: string,
  body: unknown,
): Promise<number> {
  const res = await srv.http(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    rawSessionId,
  });
  return res.status;
}

// Self-only view pref (view.setNotifRooms). Clamped to the caller's accessible
// rooms by the shared applyViewChange core.
const selfSetNotif = (
  srv: TestServer,
  rawSessionId: string,
  notifRooms: string[],
) => http(srv, rawSessionId, "PUT", "/api/me/view/notif-rooms", { notifRooms });
// Owner-gated allowedRooms grant; prune-clamps the target's notifRooms.
const ownerSetAccess = (
  srv: TestServer,
  ownerRawSessionId: string,
  username: string,
  allowedRooms: string[],
) =>
  http(
    srv,
    ownerRawSessionId,
    "PUT",
    `/api/users/${encodeURIComponent(username)}/access`,
    { allowedRooms },
  );

// Poll the persisted record until a predicate holds.
async function waitForUserField(
  userId: string,
  pred: (u: UserRecord) => boolean,
  timeoutMs = 2000,
): Promise<UserRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const u = getUserById(userId);
    if (u && pred(u)) return u;
    if (Date.now() > deadline) throw new Error("waitForUserField timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("view.setNotifRooms clamps to accessible (3d.9b, self-only)", () => {
  it("legacy-pref migration (former claim_user) clamps notif to the caller's accessible rooms", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2"); // live but NOT granted
    const memberId = getUserByName(member.username)!.id;
    expect(updateUserById(memberId, { allowedRooms: [r1] }).ok).toBe(true);

    // The store migration PUTs the legacy notif pref to its self-only view.*
    // route (replacing claim_user). r2 is inaccessible: notif keeps only r1.
    // The call still 204s (the clamp is silent — no oracle).
    expect(await selfSetNotif(server, member.rawSessionId, [r1, r2])).toBe(204);
    const u = await waitForUserField(
      memberId,
      (x) => x.notifRooms.length === 1,
    );
    expect(u.notifRooms).toEqual([r1]); // r2 dropped
  });

  it("an owner (allowedRooms=[]) saving their OWN notifRooms keeps every live room (rule access)", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const ownerId = getUserByName(owner.username)!.id;
    expect(getUserById(ownerId)!.allowedRooms).toEqual([]); // owner: rule access

    expect(await selfSetNotif(server, owner.rawSessionId, [r1, r2])).toBe(204);
    // Clamps to the owner's accessible set (all live rooms), not allowedRooms=[].
    expect(getUserById(ownerId)!.notifRooms).toEqual([r1, r2]);
  });

  it("a member saving their OWN notifRooms clamps to their current grants", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const memberId = getUserByName(member.username)!.id;
    expect(updateUserById(memberId, { allowedRooms: [r1] }).ok).toBe(true);

    expect(await selfSetNotif(server, member.rawSessionId, [r1, r2])).toBe(204);
    expect(getUserById(memberId)!.notifRooms).toEqual([r1]); // r2 dropped
  });
});

describe("users.setAccess prune-clamps notifRooms to the new access (3d.9b)", () => {
  it("revoking a room prunes the member's existing notif pointing at it", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const memberId = getUserByName(member.username)!.id;

    // Grant r1 + r2, then the member sets notif [r1,r2] (self).
    expect(
      await ownerSetAccess(server, owner.rawSessionId, member.username, [
        r1,
        r2,
      ]),
    ).toBe(200);
    expect(await selfSetNotif(server, member.rawSessionId, [r1, r2])).toBe(204);
    expect(getUserById(memberId)!.notifRooms).toEqual([r1, r2]);

    // Owner revokes r2: setAccess prune-clamps notif -> [r1] in ONE write (the
    // atomic clamp deferred from slice 6).
    expect(
      await ownerSetAccess(server, owner.rawSessionId, member.username, [r1]),
    ).toBe(200);
    expect(getUserById(memberId)!.allowedRooms).toEqual([r1]);
    expect(getUserById(memberId)!.notifRooms).toEqual([r1]);
  });
});
