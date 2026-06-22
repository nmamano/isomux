// Phase 3b slice 3 — update_user notifRooms clamp under RULE-BASED access.
//
// The WS update_user handler enforces notifRooms ⊆ ACCESSIBLE rooms. Before 3b
// that was notifRooms ⊆ allowedRooms, which is now wrong: owners carry
// allowedRooms=[] but access every room by rule, so an owner saving notifRooms
// must NOT be pruned to []. Members still prune to their granted rooms (whether
// the grant set is being changed in the same command or read from the record).
// Asserts the PERSISTED record so the test is robust across the slice-5
// user-wire projection change (which moves notifRooms off the all-audience wire).

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName, getUserById, updateUserById } from "../users.ts";
import type { UserRecord } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

let reqSeq = 0;
const nextReqId = () => `usr-${++reqSeq}`;

async function connectSettled(
  srv: TestServer,
  rawSessionId: string,
): Promise<TestSocket> {
  const sock = await srv.connectWs(rawSessionId);
  await sock.waitFor("presence_list");
  return sock;
}

// Send update_user over WS and block on its settings_save_response ack (so the
// persisted record reflects the change before we assert).
async function updateUser(
  sock: TestSocket,
  username: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const requestId = nextReqId();
  sock.send({ type: "update_user", requestId, username, changes });
  const deadline = Date.now() + 2000;
  for (;;) {
    const resp = (sock.messages as Record<string, unknown>[]).find(
      (m) => m.type === "settings_save_response" && m.requestId === requestId,
    );
    if (resp) {
      if (resp.ok !== true)
        throw new Error(`update_user failed: ${String(resp.error)}`);
      return;
    }
    if (Date.now() > deadline) throw new Error("update_user: no ack");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Poll the persisted record until a predicate holds (claim_user is fire-and-
// forget with no ack; the persisted state is the observable).
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

describe("claim_user legacy migration routes through the view clamp (3b.4)", () => {
  it("clamps migrated default/notif to the caller's accessible rooms, not a raw write", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2"); // live but NOT granted
    const memberId = getUserByName(member.username)!.id;
    expect(updateUserById(memberId, { allowedRooms: [r1] }).ok).toBe(true);

    const sock = await connectSettled(server, member.rawSessionId);
    // The legacy localStorage migration carries a default + notif that include
    // an INACCESSIBLE room (r2). Routed through applyViewChange, the clamp drops
    // r2: default -> null (unreachable), notif keeps only the accessible r1.
    sock.send({
      type: "claim_user",
      username: member.username,
      defaultRoomId: r2,
      notifRooms: [r1, r2],
    });
    const u = await waitForUserField(
      memberId,
      (x) => x.notifRooms.length === 1,
    );
    expect(u.notifRooms).toEqual([r1]); // r2 dropped, r1 kept
    expect(u.defaultRoomId).toBeNull(); // r2 inaccessible -> null (no oracle)
  });
});

describe("update_user notifRooms clamp (rule-based access, 3b.3)", () => {
  it("an owner (allowedRooms=[]) can save notifRooms for live rooms — preserved, not pruned to []", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const ownerId = getUserByName(owner.username)!.id;
    expect(getUserById(ownerId)!.allowedRooms).toEqual([]); // owner: rule access

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await updateUser(ownerSock, owner.username, { notifRooms: [r1, r2] });

    // Pre-fix this pruned to [] (the clamp used allowedRooms=[]); now it clamps
    // to the owner's accessible set (all live rooms) and preserves both.
    expect(getUserById(ownerId)!.notifRooms).toEqual([r1, r2]);
  });

  it("a member's notifRooms clamps to their CURRENT grants when only notifRooms changes", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const memberId = getUserByName(member.username)!.id;

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await updateUser(ownerSock, member.username, { allowedRooms: [r1] }); // grant r1
    // notifRooms-only update: clamp reads the member's current grants ([r1]).
    await updateUser(ownerSock, member.username, { notifRooms: [r1, r2] });
    expect(getUserById(memberId)!.allowedRooms).toEqual([r1]);
    expect(getUserById(memberId)!.notifRooms).toEqual([r1]); // r2 dropped
  });

  it("a member's notifRooms clamps to grants being set in the SAME command", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const memberId = getUserByName(member.username)!.id;

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    // allowedRooms + notifRooms together: clamp uses the incoming grants [r1].
    await updateUser(ownerSock, member.username, {
      allowedRooms: [r1],
      notifRooms: [r1, r2],
    });
    expect(getUserById(memberId)!.allowedRooms).toEqual([r1]);
    expect(getUserById(memberId)!.notifRooms).toEqual([r1]); // r2 dropped
  });
});
