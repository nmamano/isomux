// Phase 3b slice 4 - view.* REST routes + the per-user view core (applyViewChange),
// exercised through the real REST surface. Covers the NO-ORACLE write rules
// (Isomuxer3 Q2: malformed SHAPES rejected, unknown/inaccessible/hidden ROOM IDS
// silently filtered/clamped) and the clamp invariants (order deduped + accessible;
// notifRooms ⊆ effective shown).
//
// Phase 4 close-out removed view.get + view.setShown (callerless); the Default
// Room setting (view.setDefaultRoom) was later removed too. Task 9301d0f4
// restored view.setShown (the hide-rooms UI landed) and added the self-scoped
// accessible-rooms read view.listRooms (GET /api/me/rooms) - both covered in
// the second describe block below. view.get stays retired; writes are read
// back from the stored record. The hide() helper (direct persisted-state
// setup) is kept for the tests that predate the restored route.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName, getUserById, updateUserById } from "../users.ts";
import type { RoomWire } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fullStateRoomIds = (m: Record<string, unknown>): string[] =>
  (m.rooms as RoomWire[]).map((r) => r.id);
const bagLen = (sock: TestSocket, type: string): number =>
  (sock.messages as Record<string, unknown>[]).filter((m) => m.type === type)
    .length;

async function putView(
  srv: TestServer,
  rawSessionId: string,
  path: string,
  body: unknown,
): Promise<number> {
  const resp = await srv.http(`/api/me/view/${path}`, {
    method: "PUT",
    rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.status;
}

// Grant a member access directly (test setup; bypasses the WS handler).
function grant(username: string, roomIds: string[]): void {
  const id = getUserByName(username)!.id;
  const r = updateUserById(id, { allowedRooms: roomIds });
  if (!r.ok) throw new Error(`grant failed: ${r.error}`);
}

// Hide accessible rooms directly (test setup; predates the restored
// view.setShown route - kept so these tests exercise the clamp on records
// seeded outside the route, e.g. by the owner-access migration).
function hide(username: string, roomIds: string[]): void {
  const id = getUserByName(username)!.id;
  const r = updateUserById(id, { hidden: roomIds });
  if (!r.ok) throw new Error(`hide failed: ${r.error}`);
}

async function connectSettled(
  srv: TestServer,
  rawSessionId: string,
): Promise<TestSocket> {
  const sock = await srv.connectWs(rawSessionId);
  await sock.waitFor("presence_list");
  return sock;
}

async function waitForFullState(
  sock: TestSocket,
  roomIds: string[],
): Promise<Record<string, unknown>> {
  const want = roomIds.join();
  const deadline = Date.now() + 2000;
  for (;;) {
    const found = (sock.messages as Record<string, unknown>[]).find(
      (m) => m.type === "full_state" && fullStateRoomIds(m).join() === want,
    );
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no full_state with [${want}]`);
    await sleep(5);
  }
}

describe("view.* routes - no-oracle writes + clamp invariants (3b.4)", () => {
  it("setOrder dedupes (first occurrence wins), filters inaccessible, keeps hidden-but-accessible", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    server.agentManager.createRoom("R3"); // r3 inaccessible
    grant(member.username, [r1, r2]);
    hide(member.username, [r2]); // r2 accessible but hidden

    const memberId = getUserByName(member.username)!.id;
    await putView(server, member.rawSessionId, "order", {
      order: [r2, r1, r2, "no-such-room", r1],
    });
    // first-wins dedupe, inaccessible/unknown dropped, hidden-but-accessible r2 kept.
    expect(getUserById(memberId)!.order).toEqual([r2, r1]);
  });

  it("a directly-hidden room is excluded from effective notifRooms on the next view write", async () => {
    // view.setShown is gone (Phase 4); a hidden room now arrives via the
    // migration seed (here: direct setup). The clamp still fires on the next
    // view write - the same clampViewFields path the retired setShown used, and
    // the same one users.setAccess uses on revoke (covered in user-settings.test).
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);
    hide(member.username, [r2]); // r2 accessible but hidden
    const memberId = getUserByName(member.username)!.id;

    // notifRooms write clamps to effective shown (accessible \ hidden) → r2 dropped.
    await putView(server, member.rawSessionId, "notif-rooms", {
      notifRooms: [r1, r2],
    });
    expect(getUserById(memberId)!.notifRooms).toEqual([r1]);
  });

  it("rejects a malformed body SHAPE (422) but silently accepts an unknown room id", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    grant(member.username, [r1]);

    // Malformed: order is not a string[] → 422 (a shape error is allowed).
    expect(
      await putView(server, member.rawSessionId, "order", { order: "nope" }),
    ).toBe(422);
    // Unknown id is NOT rejected (rejecting would be an existence oracle) - it's
    // silently filtered, so the write still succeeds (204) and stores only r1.
    expect(
      await putView(server, member.rawSessionId, "order", {
        order: ["no-such-room", r1],
      }),
    ).toBe(204);
    expect(getUserById(getUserByName(member.username)!.id)!.order).toEqual([
      r1,
    ]);
  });

  it("multi-socket: a view change fans out a projected full_state to ALL the caller's sockets, and to no other user", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);

    const sock1 = await connectSettled(server, member.rawSessionId);
    const sock2 = await connectSettled(server, member.rawSessionId);
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    const ownerFsBefore = bagLen(ownerSock, "full_state");

    await putView(server, member.rawSessionId, "order", { order: [r2, r1] });

    // BOTH of the member's sockets receive a full_state in the new order.
    expect(fullStateRoomIds(await waitForFullState(sock1, [r2, r1]))).toEqual([
      r2,
      r1,
    ]);
    expect(fullStateRoomIds(await waitForFullState(sock2, [r2, r1]))).toEqual([
      r2,
      r1,
    ]);
    // The unrelated owner gets NO new full_state from the member's view change.
    expect(bagLen(ownerSock, "full_state")).toBe(ownerFsBefore);
  });
});

// Task 9301d0f4 - the restored view.setShown + the new view.listRooms, i.e.
// the DISPLAY level of the hierarchical room settings (ACCESS ⊇ DISPLAYED ⊇
// NOTIFICATIONS) as exercised by the Users-page hide-rooms UI.
describe("view.setShown + view.listRooms (task 9301d0f4)", () => {
  it("setShown: hidden = accessible minus shown; notifRooms pruned; unknown ids no-oracle-filtered; re-show works", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    server.agentManager.createRoom("R3"); // inaccessible to Mia
    grant(member.username, [r1, r2]);
    const memberId = getUserByName(member.username)!.id;
    await putView(server, member.rawSessionId, "notif-rooms", {
      notifRooms: [r1, r2],
    });

    // Hide r2 by sending shown=[r1] (+ an unknown id, silently filtered).
    expect(
      await putView(server, member.rawSessionId, "shown", {
        shown: [r1, "no-such-room"],
      }),
    ).toBe(204);
    expect(getUserById(memberId)!.hidden).toEqual([r2]);
    // Hiding a notified room prunes it (NOTIFICATIONS ⊆ DISPLAYED).
    expect(getUserById(memberId)!.notifRooms).toEqual([r1]);

    // Re-show: shown listing every accessible room empties hidden.
    expect(
      await putView(server, member.rawSessionId, "shown", { shown: [r1, r2] }),
    ).toBe(204);
    expect(getUserById(memberId)!.hidden).toEqual([]);

    // Malformed SHAPE is still rejected (422).
    expect(
      await putView(server, member.rawSessionId, "shown", { shown: "nope" }),
    ).toBe(422);
  });

  it("setShown fans out the projected full_state (hidden room gone) and refreshes the self record", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);

    const sock = await connectSettled(server, member.rawSessionId);
    await putView(server, member.rawSessionId, "shown", { shown: [r1] });

    // Projection excludes the hidden room.
    expect(fullStateRoomIds(await waitForFullState(sock, [r1]))).toEqual([r1]);
    // The subject's own record refreshes (user_self_updated carries hidden) so
    // the Users-page form can read back what it just saved. Poll the bag for
    // the post-write emission (connect-time self records precede it).
    const deadline = Date.now() + 2000;
    for (;;) {
      const found = (sock.messages as Record<string, unknown>[]).find(
        (m) =>
          m.type === "user_self_updated" &&
          JSON.stringify((m.user as { hidden: string[] }).hidden) ===
            JSON.stringify([r2]),
      );
      if (found) break;
      if (Date.now() > deadline)
        throw new Error("no user_self_updated with hidden=[r2]");
      await sleep(5);
    }
  });

  it("listRooms returns id+name for every ACCESSIBLE room - hidden included, inaccessible excluded", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3"); // not granted to Mia
    grant(member.username, [r1, r2]);
    hide(member.username, [r2]);

    const resp = await server.http("/api/me/rooms", {
      method: "GET",
      rawSessionId: member.rawSessionId,
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      rooms: { id: string; name: string }[];
    };
    // Hidden-but-accessible r2 IS listed (this read exists so a member can
    // re-show it); ungranted r3 is not.
    expect(body.rooms.map((r) => r.id)).toEqual([r1, r2]);
    expect(body.rooms.find((r) => r.id === r2)?.name).toBe("R2");

    // An owner reaches every live room by rule.
    const ownerResp = await server.http("/api/me/rooms", {
      method: "GET",
      rawSessionId: owner.rawSessionId,
    });
    const ownerBody = (await ownerResp.json()) as {
      rooms: { id: string }[];
    };
    expect(ownerBody.rooms.map((r) => r.id)).toEqual([r1, r2, r3]);
  });
});

// Task 6c23d908 - view.setTucked: a tucked room leaves the member's tab bar
// for its overflow chip but stays in the projection, so presence still flows.
describe("view.setTucked (task 6c23d908)", () => {
  async function waitForSelfTucked(
    sock: TestSocket,
    tucked: string[],
  ): Promise<void> {
    const want = JSON.stringify(tucked);
    const deadline = Date.now() + 2000;
    for (;;) {
      const found = (sock.messages as Record<string, unknown>[]).some(
        (m) =>
          m.type === "user_self_updated" &&
          JSON.stringify((m.user as { tucked: string[] }).tucked) === want,
      );
      if (found) return;
      if (Date.now() > deadline)
        throw new Error(`no user_self_updated with tucked=${want}`);
      await sleep(5);
    }
  }

  it("stores the full list: dedupes, drops unknown and inaccessible ids, keeps hidden-but-accessible ones", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3"); // inaccessible to Mia
    grant(member.username, [r1, r2]);
    hide(member.username, [r2]);
    const memberId = getUserByName(member.username)!.id;

    expect(
      await putView(server, member.rawSessionId, "tucked", {
        tucked: [r2, r1, r2, r3, "no-such-room"],
      }),
    ).toBe(204);
    expect(getUserById(memberId)!.tucked).toEqual([r2, r1]);
    // Untuck is a write of the shorter list.
    expect(
      await putView(server, member.rawSessionId, "tucked", { tucked: [r2] }),
    ).toBe(204);
    expect(getUserById(memberId)!.tucked).toEqual([r2]);
    expect(
      await putView(server, member.rawSessionId, "tucked", { tucked: r1 }),
    ).toBe(422);
    expect(getUserById(memberId)!.tucked).toEqual([r2]);
  });

  it("sends the member's own record and no full_state; other members get nothing", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const other = await server.seedMember("Ola");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);
    grant(other.username, [r1, r2]);

    const sock = await connectSettled(server, member.rawSessionId);
    const otherSock = await connectSettled(server, other.rawSessionId);
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    const fsBefore = bagLen(sock, "full_state");
    const otherBefore = otherSock.messages.length;
    const ownerBefore = ownerSock.messages.length;

    await putView(server, member.rawSessionId, "tucked", { tucked: [r2] });
    await waitForSelfTucked(sock, [r2]);
    await sleep(50);
    // The tucked room stays in the projection: no full_state is needed.
    expect(bagLen(sock, "full_state")).toBe(fsBefore);
    expect(otherSock.messages.slice(otherBefore)).toEqual([]);
    // Owners get the full record on the admin channel, as for hidden and
    // order; nothing goes out on the public channel.
    const ownerNew = (ownerSock.messages as Record<string, unknown>[]).slice(
      ownerBefore,
    );
    expect(ownerNew.map((m) => m.type)).toEqual(["user_admin_updated"]);
    expect((ownerNew[0].user as { tucked: string[] }).tucked).toEqual([r2]);
  });

  it("never puts tucked on the public user wire", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const other = await server.seedMember("Ola");
    const r1 = server.agentManager.getRooms()[0].id;
    grant(member.username, [r1]);
    await putView(server, member.rawSessionId, "tucked", { tucked: [r1] });
    // A connect sends the public roster; a public record change follows.
    const otherSock = await connectSettled(server, other.rawSessionId);
    await putView(server, member.rawSessionId, "notif-rooms", {
      notifRooms: [r1],
    });
    await otherSock.waitFor("user_updated");
    const publicRecords = (otherSock.messages as Record<string, unknown>[])
      .filter((m) => m.type === "users_list" || m.type === "user_updated")
      .flatMap((m) =>
        m.type === "users_list"
          ? (m.users as Record<string, unknown>[])
          : [m.user as Record<string, unknown>],
      );
    expect(publicRecords.length).toBeGreaterThan(0);
    expect(publicRecords.every((u) => !("tucked" in u))).toBe(true);
  });

  it("a hidden room keeps its tucked flag and comes back tucked when shown again", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);
    const memberId = getUserByName(member.username)!.id;
    const sock = await connectSettled(server, member.rawSessionId);

    await putView(server, member.rawSessionId, "tucked", { tucked: [r2] });
    // Tucked is not hidden: the room stays in the member's projection.
    expect(
      fullStateRoomIds(
        (sock.messages as Record<string, unknown>[]).findLast(
          (m) => m.type === "full_state",
        )!,
      ),
    ).toEqual([r1, r2]);

    await putView(server, member.rawSessionId, "shown", { shown: [r1] });
    await waitForFullState(sock, [r1]);
    expect(getUserById(memberId)!.tucked).toEqual([r2]);

    await putView(server, member.rawSessionId, "shown", { shown: [r1, r2] });
    await waitForFullState(sock, [r1, r2]);
    expect(getUserById(memberId)!.hidden).toEqual([]);
    expect(getUserById(memberId)!.tucked).toEqual([r2]);
  });
});
