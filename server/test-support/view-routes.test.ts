// Phase 3b slice 4 — view.* REST routes + the per-user view core (applyViewChange),
// exercised through the real REST surface. Covers the NO-ORACLE write rules
// (Isomuxer3 Q2: malformed SHAPES rejected, unknown/inaccessible/hidden ROOM IDS
// silently filtered/clamped) and the clamp invariants (order deduped + accessible;
// notifRooms ⊆ effective shown; defaultRoomId ∈ effective shown else null).
//
// Phase 4 close-out removed view.get + view.setShown (callerless). The remaining
// routes are view.{setOrder,setNotifRooms,setDefaultRoom}; the `hidden` set is set
// via direct persisted-state setup (the hide() helper, mirroring the migration
// seed), and writes are read back from the stored record (full_state carries view
// prefs at runtime — there is no dedicated GET to assert against).

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

// Hide accessible rooms directly (test setup). view.setShown was removed in the
// Phase 4 close-out (callerless); the `hidden` set is now seeded only by the
// owner-access migration, so tests set it via the persisted record. The clamp
// still fires on the next view/access write (clampViewFields), as live paths do.
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

describe("view.* routes — no-oracle writes + clamp invariants (3b.4)", () => {
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

  it("a directly-hidden room is excluded from effective notif/default on the next view write", async () => {
    // view.setShown is gone (Phase 4); a hidden room now arrives via the
    // migration seed (here: direct setup). The clamp still fires on the next
    // view write — the same clampViewFields path the retired setShown used, and
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

    // defaultRoom write to the hidden r2 clamps to null (no oracle).
    await putView(server, member.rawSessionId, "default-room", {
      defaultRoomId: r2,
    });
    expect(getUserById(memberId)!.defaultRoomId).toBeNull();
  });

  it("setDefaultRoom: inaccessible and accessible-but-hidden BOTH clamp to null (no oracle)", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3"); // inaccessible
    grant(member.username, [r1, r2]);
    hide(member.username, [r2]); // r2 accessible but hidden
    const memberId = getUserByName(member.username)!.id;

    // Inaccessible r3 → null.
    expect(
      await putView(server, member.rawSessionId, "default-room", {
        defaultRoomId: r3,
      }),
    ).toBe(204);
    expect(getUserById(memberId)!.defaultRoomId).toBeNull();
    // Accessible-but-hidden r2 → null (IDENTICAL outcome — no oracle).
    expect(
      await putView(server, member.rawSessionId, "default-room", {
        defaultRoomId: r2,
      }),
    ).toBe(204);
    expect(getUserById(memberId)!.defaultRoomId).toBeNull();
    // A visible room sticks.
    expect(
      await putView(server, member.rawSessionId, "default-room", {
        defaultRoomId: r1,
      }),
    ).toBe(204);
    expect(getUserById(memberId)!.defaultRoomId).toBe(r1);
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
    // Unknown id is NOT rejected (rejecting would be an existence oracle) — it's
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
