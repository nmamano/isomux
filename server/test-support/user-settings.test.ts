// The notifRooms clamp on the persisted user record: a member's own save
// through the self-only view route keeps only rooms they can access, and an
// owner's users.setAccess prunes the member's notifRooms to the new access.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName, getUserById, updateUserById } from "../users.ts";

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

describe("view.setNotifRooms clamps to accessible", () => {
  it("an owner (allowedRooms=[]) saving their OWN notifRooms keeps every live room (rule access)", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
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
    await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const memberId = getUserByName(member.username)!.id;
    expect(updateUserById(memberId, { allowedRooms: [r1] }).ok).toBe(true);

    expect(await selfSetNotif(server, member.rawSessionId, [r1, r2])).toBe(204);
    expect(getUserById(memberId)!.notifRooms).toEqual([r1]); // r2 dropped
  });
});

describe("users.setAccess prune-clamps notifRooms to the new access", () => {
  it("revoking a room prunes the member's existing notif pointing at it", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
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

    // Owner revokes r2: setAccess prune-clamps notif -> [r1] in ONE write.
    expect(
      await ownerSetAccess(server, owner.rawSessionId, member.username, [r1]),
    ).toBe(200);
    expect(getUserById(memberId)!.allowedRooms).toEqual([r1]);
    expect(getUserById(memberId)!.notifRooms).toEqual([r1]);
  });
});
