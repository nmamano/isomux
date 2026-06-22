// Phase 3b slice 4 — view.* REST routes + the per-user view core (applyViewChange
// / getViewProjection), exercised through the real REST surface. Covers the
// NO-ORACLE write rules (Isomuxer3 Q2: malformed SHAPES rejected, unknown/
// inaccessible/hidden ROOM IDS silently filtered/clamped) and the clamp
// invariants (order deduped + accessible; effective shown = accessible \ hidden;
// notifRooms ⊆ effective shown; defaultRoomId ∈ effective shown else null).

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

interface ViewBody {
  order: string[];
  shown: string[];
  notifRooms: string[];
  defaultRoomId: string | null;
}

async function getView(
  srv: TestServer,
  rawSessionId: string,
): Promise<{ status: number; body: ViewBody }> {
  const resp = await srv.http("/api/me/view", { rawSessionId });
  return { status: resp.status, body: (await resp.json()) as ViewBody };
}

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
  it("view.get returns ONLY effective values (no inaccessible id; shown filters hidden)", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3"); // never granted to member
    grant(member.username, [r1, r2]);

    expect(
      await putView(server, member.rawSessionId, "shown", { shown: [r1] }),
    ).toBe(204); // hide r2
    expect(
      await putView(server, member.rawSessionId, "order", {
        order: [r2, r1, r3],
      }),
    ).toBe(204);

    const { status, body } = await getView(server, member.rawSessionId);
    expect(status).toBe(200);
    expect(body.shown).toEqual([r1]); // r2 hidden, r3 inaccessible
    expect(body.order).toEqual([r2, r1]); // r2 kept (accessible), r3 dropped
    expect(body.order).not.toContain(r3);
    expect(body.shown).not.toContain(r3);
  });

  it("setOrder dedupes (first occurrence wins), filters inaccessible, keeps hidden-but-accessible", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    server.agentManager.createRoom("R3"); // r3 inaccessible
    grant(member.username, [r1, r2]);
    await putView(server, member.rawSessionId, "shown", { shown: [r1] }); // hide r2

    const memberId = getUserByName(member.username)!.id;
    await putView(server, member.rawSessionId, "order", {
      order: [r2, r1, r2, "no-such-room", r1],
    });
    // first-wins dedupe, inaccessible/unknown dropped, hidden-but-accessible r2 kept.
    expect(getUserById(memberId)!.order).toEqual([r2, r1]);
  });

  it("setShown re-clamps notifRooms AND defaultRoomId when a room is hidden", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    grant(member.username, [r1, r2]);

    await putView(server, member.rawSessionId, "notif-rooms", {
      notifRooms: [r1, r2],
    });
    await putView(server, member.rawSessionId, "default-room", {
      defaultRoomId: r2,
    });
    let v = (await getView(server, member.rawSessionId)).body;
    expect([...v.notifRooms].sort()).toEqual([r1, r2].sort());
    expect(v.defaultRoomId).toBe(r2);

    // Hide r2 → notif drops r2; default (was r2) re-clamps to null.
    expect(
      await putView(server, member.rawSessionId, "shown", { shown: [r1] }),
    ).toBe(204);
    v = (await getView(server, member.rawSessionId)).body;
    expect(v.notifRooms).toEqual([r1]);
    expect(v.defaultRoomId).toBeNull();
  });

  it("setDefaultRoom: inaccessible and accessible-but-hidden BOTH clamp to null (no oracle)", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const r3 = server.agentManager.createRoom("R3"); // inaccessible
    grant(member.username, [r1, r2]);
    await putView(server, member.rawSessionId, "shown", { shown: [r1] }); // hide r2

    // Inaccessible r3 → null.
    expect(
      await putView(server, member.rawSessionId, "default-room", {
        defaultRoomId: r3,
      }),
    ).toBe(204);
    expect(
      (await getView(server, member.rawSessionId)).body.defaultRoomId,
    ).toBeNull();
    // Accessible-but-hidden r2 → null (IDENTICAL outcome — no oracle).
    expect(
      await putView(server, member.rawSessionId, "default-room", {
        defaultRoomId: r2,
      }),
    ).toBe(204);
    expect(
      (await getView(server, member.rawSessionId)).body.defaultRoomId,
    ).toBeNull();
    // A visible room sticks.
    expect(
      await putView(server, member.rawSessionId, "default-room", {
        defaultRoomId: r1,
      }),
    ).toBe(204);
    expect(
      (await getView(server, member.rawSessionId)).body.defaultRoomId,
    ).toBe(r1);
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
