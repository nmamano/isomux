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
  // The connect-time provider_accounts_updated is async and may land after
  // presence_list; a test that marks the bag must not see it as a fanout.
  await sock.waitFor("provider_accounts_updated");
  return sock;
}

// waitFor matches any frame already in the bag; this one only frames after
// `mark`, for a fanout whose type also arrived at connect.
async function waitForAfter(
  sock: TestSocket,
  mark: number,
  type: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const found = (sock.messages as Record<string, unknown>[])
      .slice(mark)
      .find((m) => m.type === type);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no ${type} after ${mark}`);
    await sleep(5);
  }
}

// Frames after `mark`, without the pongs the fence adds.
const framesAfter = (
  sock: TestSocket,
  mark: number,
): Record<string, unknown>[] =>
  (sock.messages as Record<string, unknown>[])
    .slice(mark)
    .filter((m) => m.type !== "pong");

// A pong answers a ping sent after the write returned, so every frame the write
// sent to that socket arrived before it.
async function fence(...socks: TestSocket[]): Promise<void> {
  for (const sock of socks) {
    const before = bagLen(sock, "pong");
    sock.send({ type: "ping" });
    const deadline = Date.now() + 2000;
    while (bagLen(sock, "pong") <= before) {
      if (Date.now() > deadline) throw new Error("no pong");
      await sleep(5);
    }
  }
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
    await server.seedOwner("Morgan");
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

  it("multi-socket: an order-only change sends room_order_updated with the projected rooms to ALL the caller's sockets, replays nothing, and reaches no other user", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3"); // hidden from Mia's view
    const r4 = server.agentManager.createRoom("R4"); // inaccessible to Mia
    grant(member.username, [r1, r2, r3]);
    hide(member.username, [r3]);
    const agent = await server.agentManager.spawn(
      "A",
      server.stateRoot,
      "default",
      undefined,
      undefined,
      r1,
    );
    if (!agent) throw new Error("spawn failed");
    await server.agentManager.sendMessage(agent.id, "/help", owner.username);

    const sock1 = await connectSettled(server, member.rawSessionId);
    const sock2 = await connectSettled(server, member.rawSessionId);
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    // Enabling condition: a replay to this member carries transcript and
    // command frames, so their absence below is the change, not an empty office.
    expect(bagLen(sock1, "log_entry")).toBeGreaterThan(0);
    expect(bagLen(sock1, "slash_commands")).toBeGreaterThan(0);
    const before = (sock: TestSocket) => sock.messages.length;
    const mark1 = before(sock1);
    const mark2 = before(sock2);
    const markOwner = before(ownerSock);

    await putView(server, member.rawSessionId, "order", {
      order: [r2, r3, r1],
    });

    for (const [sock, mark] of [
      [sock1, mark1],
      [sock2, mark2],
    ] as const) {
      const msg = await waitForAfter(sock, mark, "room_order_updated");
      // The socket's projection: hidden r3 and inaccessible R4 stay out.
      expect((msg.rooms as RoomWire[]).map((r) => r.id)).toEqual([r2, r1]);
      // Presence follows room_order_updated on the same socket, so every frame
      // of this fanout has arrived by the time it shows.
      await waitForAfter(sock, mark, "presence_list");
      const types = (sock.messages as Record<string, unknown>[])
        .slice(mark)
        .map((m) => m.type);
      for (const replayType of [
        "full_state",
        "log_entry",
        "slash_commands",
        "log_replay_complete",
      ]) {
        expect(types).not.toContain(replayType);
      }
    }
    // The order is the member's view: the office's room order is unchanged.
    expect(server.agentManager.getRooms().map((r) => r.id)).toEqual([
      r1,
      r2,
      r3,
      r4,
    ]);
    // The unrelated owner gets nothing from the member's view change.
    await fence(ownerSock);
    expect(framesAfter(ownerSock, markOwner).map((m) => m.type)).not.toContain(
      "room_order_updated",
    );
    expect(bagLen(ownerSock, "full_state")).toBe(1);
  });
});

// Task 9301d0f4 - the restored view.setShown + the new view.listRooms, i.e.
// the DISPLAY level of the hierarchical room settings (ACCESS ⊇ DISPLAYED ⊇
// NOTIFICATIONS) as exercised by the Users-page hide-rooms UI.
describe("view.setShown + view.listRooms (task 9301d0f4)", () => {
  it("setShown: hidden = accessible minus shown; notifRooms pruned; unknown ids no-oracle-filtered; re-show works", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
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

  it("setShown fans out the projected full_state (hidden room gone) with the transcript replay, and refreshes the self record", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);
    const agent = await server.agentManager.spawn(
      "A",
      server.stateRoot,
      "default",
      undefined,
      undefined,
      r1,
    );
    if (!agent) throw new Error("spawn failed");
    await server.agentManager.sendMessage(agent.id, "/help", owner.username);

    const sock = await connectSettled(server, member.rawSessionId);
    const mark = sock.messages.length;
    await putView(server, member.rawSessionId, "shown", { shown: [r1] });

    // Projection excludes the hidden room.
    expect(fullStateRoomIds(await waitForFullState(sock, [r1]))).toEqual([r1]);
    // The visible set changed, so the still-visible agent's transcript and
    // commands replay behind it, up to the fence.
    await waitForAfter(sock, mark, "log_replay_complete");
    const types = (sock.messages as Record<string, unknown>[])
      .slice(mark)
      .map((m) => m.type);
    expect(types).toContain("log_entry");
    expect(types).toContain("slash_commands");
    expect(types).not.toContain("room_order_updated");
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
    const owner = await server.seedOwner("Morgan");
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
  it("stores the full list: dedupes, drops unknown and inaccessible ids, keeps hidden-but-accessible ones", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
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

  // tucked and pushRooms ride only the private record channels.
  it("setTucked and setPushRooms send the member's own record and the owners' admin record, no full_state and nothing to other members", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const other = await server.seedMember("Ola");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);
    grant(other.username, [r1, r2]);
    // Each write below also changes the member's notifications (task
    // 611c968e): the tuck drops r2's, the push adds r1's. That change stays
    // on the private channels too.
    const memberRecordId = getUserByName(member.username)!.id;
    updateUserById(memberRecordId, { notifRooms: [r2], pushRooms: [] });

    const sock = await connectSettled(server, member.rawSessionId);
    const otherSock = await connectSettled(server, other.rawSessionId);
    const ownerSock = await connectSettled(server, owner.rawSessionId);

    for (const [path, body, field, want, notif] of [
      ["tucked", { tucked: [r2] }, "tucked", [r2], []],
      ["push-rooms", { pushRooms: [r1] }, "pushRooms", [r1], [r1]],
    ] as const) {
      const selfBefore = sock.messages.length;
      const otherBefore = otherSock.messages.length;
      const ownerBefore = ownerSock.messages.length;
      expect(await putView(server, member.rawSessionId, path, body)).toBe(204);
      await waitForAfter(ownerSock, ownerBefore, "user_admin_updated");
      await fence(sock, otherSock, ownerSock);
      // The room stays in the projection: no full_state is needed.
      const selfNew = framesAfter(sock, selfBefore);
      expect(selfNew.map((m) => m.type)).toEqual(["user_self_updated"]);
      expect((selfNew[0].user as Record<string, unknown>)[field]).toEqual(want);
      expect((selfNew[0].user as Record<string, unknown>).notifRooms).toEqual(
        notif,
      );
      expect(framesAfter(otherSock, otherBefore)).toEqual([]);
      // Owners get the full record on the admin channel, as for hidden and
      // order; nothing goes out on the public channel.
      const ownerNew = framesAfter(ownerSock, ownerBefore);
      expect(ownerNew.map((m) => m.type)).toEqual(["user_admin_updated"]);
      expect((ownerNew[0].user as Record<string, unknown>)[field]).toEqual(
        want,
      );
    }
  });

  it("a hidden room keeps its tucked flag and comes back tucked when shown again", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);
    const memberId = getUserByName(member.username)!.id;
    const sock = await connectSettled(server, member.rawSessionId);

    await putView(server, member.rawSessionId, "tucked", { tucked: [r2] });
    await putView(server, member.rawSessionId, "shown", { shown: [r1] });
    await waitForFullState(sock, [r1]);
    expect(getUserById(memberId)!.tucked).toEqual([r2]);

    await putView(server, member.rawSessionId, "shown", { shown: [r1, r2] });
    await waitForFullState(sock, [r1, r2]);
    expect(getUserById(memberId)!.hidden).toEqual([]);
    expect(getUserById(memberId)!.tucked).toEqual([r2]);
  });
});

// Task 0c3fa26f - view.setPushRooms: the rooms whose turn ends push to the
// member's devices (the Devices column). The same clamp as notifRooms holds
// it within the shown rooms; it rides only the private record channels.
describe("view.setPushRooms (task 0c3fa26f)", () => {
  async function http(
    srv: TestServer,
    rawSessionId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<number> {
    const resp = await srv.http(path, {
      method,
      rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return resp.status;
  }

  it("stores the full list within the shown rooms: dedupes, drops unknown, inaccessible and hidden ids", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3"); // inaccessible to Mia
    const r4 = server.agentManager.createRoom("R4"); // hidden by Mia
    grant(member.username, [r1, r2, r4]);
    hide(member.username, [r4]);
    const memberId = getUserByName(member.username)!.id;
    expect(getUserById(memberId)!.pushRooms).toEqual([]);

    expect(
      await putView(server, member.rawSessionId, "push-rooms", {
        pushRooms: [r2, r1, r2, r3, r4, "no-such-room"],
      }),
    ).toBe(204);
    expect(getUserById(memberId)!.pushRooms).toEqual([r2, r1]);
    // Push comes with notifications (task 611c968e).
    expect([...getUserById(memberId)!.notifRooms].sort()).toEqual(
      [r1, r2].sort(),
    );
    expect(
      await putView(server, member.rawSessionId, "push-rooms", {
        pushRooms: r1,
      }),
    ).toBe(422);
    expect(getUserById(memberId)!.pushRooms).toEqual([r2, r1]);
  });

  it("hiding a room, losing access to it and closing it each drop it", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3");
    grant(member.username, [r1, r2, r3]);
    const memberId = getUserByName(member.username)!.id;
    await putView(server, member.rawSessionId, "push-rooms", {
      pushRooms: [r1, r2, r3],
    });
    expect(getUserById(memberId)!.pushRooms).toEqual([r1, r2, r3]);

    await putView(server, member.rawSessionId, "shown", { shown: [r2, r3] });
    expect(getUserById(memberId)!.pushRooms).toEqual([r2, r3]);

    expect(
      await http(
        server,
        owner.rawSessionId,
        "PUT",
        `/api/users/${encodeURIComponent(member.username)}/access`,
        { allowedRooms: [r1, r3] },
      ),
    ).toBe(200);
    expect(getUserById(memberId)!.pushRooms).toEqual([r3]);

    expect(
      await http(server, owner.rawSessionId, "DELETE", `/api/rooms/${r3}`),
    ).toBe(204);
    expect(getUserById(memberId)!.pushRooms).toEqual([]);
  });

  it("a demotion drops the rooms the member no longer reaches", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1]);
    const memberId = getUserByName(member.username)!.id;
    const setRole = (role: string) =>
      http(
        server!,
        owner.rawSessionId,
        "PATCH",
        `/api/users/${encodeURIComponent(member.username)}`,
        { role },
      );

    // As an owner Mia reaches every room by rule, so both rooms stay.
    expect(await setRole("owner")).toBe(200);
    await putView(server, member.rawSessionId, "push-rooms", {
      pushRooms: [r1, r2],
    });
    expect(getUserById(memberId)!.pushRooms).toEqual([r1, r2]);

    expect(await setRole("member")).toBe(200);
    expect(getUserById(memberId)!.role).toBe("member");
    expect(getUserById(memberId)!.allowedRooms).toEqual([r1]);
    expect(getUserById(memberId)!.pushRooms).toEqual([r1]);
  });
});

// Task 611c968e - one ordered view level per room: Hidden < Tucked < Shown <
// Notifications < Push. The clamp keeps the stored lists on a level whatever
// the route: a tucked room has no notifications and no push, and push comes
// with notifications. The list a write carries wins.
describe("the view level invariant (task 611c968e)", () => {
  async function setUp() {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);
    const memberId = getUserByName(member.username)!.id;
    updateUserById(memberId, { notifRooms: [], pushRooms: [], tucked: [] });
    const put = async (path: string, body: unknown) =>
      expect(await putView(server!, member.rawSessionId, path, body)).toBe(204);
    const lists = () => {
      const u = getUserById(memberId)!;
      return {
        tucked: [...u.tucked].sort(),
        notifRooms: [...u.notifRooms].sort(),
        pushRooms: [...u.pushRooms].sort(),
      };
    };
    return { r1, r2, put, lists };
  }

  it("a tuck drops the room's notifications and push, an untuck does not bring them back, and a tucked room takes neither", async () => {
    const { r1, r2, put, lists } = await setUp();
    await put("push-rooms", { pushRooms: [r1, r2] });
    expect(lists().pushRooms).toEqual([r1, r2].sort());
    expect(lists().notifRooms).toEqual([r1, r2].sort());

    await put("tucked", { tucked: [r2] });
    expect(lists()).toEqual({
      tucked: [r2],
      notifRooms: [r1],
      pushRooms: [r1],
    });

    await put("tucked", { tucked: [] });
    expect(lists()).toEqual({ tucked: [], notifRooms: [r1], pushRooms: [r1] });

    await put("tucked", { tucked: [r2] });
    await put("notif-rooms", { notifRooms: [r1, r2] });
    expect(lists().notifRooms).toEqual([r1]);
    await put("push-rooms", { pushRooms: [r1, r2] });
    expect(lists()).toEqual({
      tucked: [r2],
      notifRooms: [r1],
      pushRooms: [r1],
    });
  });

  it("a push write turns notifications on for its rooms; a notifications write without a room turns its push off; a push write without a room keeps its notifications", async () => {
    const { r1, r2, put, lists } = await setUp();
    await put("push-rooms", { pushRooms: [r2] });
    expect(lists()).toEqual({ tucked: [], notifRooms: [r2], pushRooms: [r2] });

    await put("notif-rooms", { notifRooms: [r1] });
    expect(lists()).toEqual({ tucked: [], notifRooms: [r1], pushRooms: [] });

    await put("push-rooms", { pushRooms: [r1] });
    expect(lists()).toEqual({ tucked: [], notifRooms: [r1], pushRooms: [r1] });

    // Push to Notifications is one push write.
    await put("push-rooms", { pushRooms: [] });
    expect(lists()).toEqual({ tucked: [], notifRooms: [r1], pushRooms: [] });
  });
});
