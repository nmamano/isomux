// Phase 3c slice 4 — Presence projection, id-keyed wire.
//
// Presence is its own connectionId-keyed map (server/presence.ts). An inbound
// presence_update carries the sender's GLOBAL currentRoomId, which the server
// validates directly against the sender's room access (live room + canAccess,
// else null) and stores as-is. presence_list re-emits that stable id to every
// recipient, filtered to the rooms each recipient can see. There is no dense
// per-recipient remap anymore — the id is identical across recipients; only
// membership (is the room visible to this recipient?) is per-recipient.
//
// Determinism: a presence_update that changes visible state triggers a
// synchronous pushPresenceListToEachWs; value-based waiters (or a count-based
// wait when asserting an omission / a no-op-on-the-id change) settle without
// arbitrary sleeps.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import type { PresenceInfo } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = Record<string, unknown>;
const bag = (sock: TestSocket): Msg[] => sock.messages as Msg[];

let reqSeq = 0;
const nextReqId = () => `preq-${++reqSeq}`;

async function waitForMessageWhere(
  sock: TestSocket,
  pred: (m: Msg) => boolean,
  timeoutMs = 2000,
): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = bag(sock).find(pred);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForMessageWhere timed out; saw types: [${bag(sock)
          .map((m) => m.type)
          .join(", ")}]`,
      );
    }
    await sleep(5);
  }
}

function connectionIdOf(sock: TestSocket): string {
  const ctx = bag(sock).find((m) => m.type === "session_context");
  if (!ctx) throw new Error("no session_context on socket");
  return (ctx.context as { connectionId: string }).connectionId;
}

async function connectSettled(
  srv: TestServer,
  rawSessionId: string,
): Promise<TestSocket> {
  const sock = await srv.connectWs(rawSessionId);
  await sock.waitFor("presence_list");
  return sock;
}

async function setAccess(
  ownerSock: TestSocket,
  username: string,
  roomIds: string[],
): Promise<void> {
  const requestId = nextReqId();
  ownerSock.send({
    type: "update_user",
    requestId,
    username,
    changes: { allowedRooms: roomIds },
  });
  const resp = await waitForMessageWhere(
    ownerSock,
    (m) => m.type === "settings_save_response" && m.requestId === requestId,
  );
  if (resp.ok !== true)
    throw new Error(`setAccess failed: ${String(resp.error)}`);
}

function makeRoomsBeforeOwner(srv: TestServer, names: string[]): string[] {
  return names.map((n) => srv.agentManager.createRoom(n));
}

function presenceEntry(m: Msg, connectionId: string): PresenceInfo | undefined {
  return (m.entries as PresenceInfo[]).find(
    (e) => e.connectionId === connectionId,
  );
}

function presenceUpdate(sock: TestSocket, currentRoomId: string | null): void {
  sock.send({
    type: "presence_update",
    currentRoomId,
    focusedAgentId: null,
    viewMode: "office",
  });
}

// Count of presence_list messages a socket has received so far — for count-based
// waits when asserting an omission or an id-stable (value-unchanged) rebroadcast.
const presenceCount = (sock: TestSocket): number =>
  bag(sock).filter((m) => m.type === "presence_list").length;

async function waitForPresenceAfter(
  sock: TestSocket,
  before: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (presenceCount(sock) <= before) {
    if (Date.now() > deadline)
      throw new Error(`no presence rebroadcast: ${label}`);
    await sleep(5);
  }
}

describe("presence — id-keyed wire (Phase 3c slice 4)", () => {
  it("currentRoomId is the stable global id, identical across recipients", async () => {
    server = await startTestServer();
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r2, r3]);
    const memberSock = await connectSettled(server, member.rawSessionId);
    const memberCid = connectionIdOf(memberSock);

    presenceUpdate(memberSock, r3);

    // Both the owner (full access) and the member see the SAME stable id — no
    // per-recipient remap. R3 is visible to both, so both render the ghost.
    const ownerView = await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "presence_list" &&
        presenceEntry(m, memberCid)?.currentRoomId === r3,
    );
    const memberView = await waitForMessageWhere(
      memberSock,
      (m) =>
        m.type === "presence_list" &&
        presenceEntry(m, memberCid)?.currentRoomId === r3,
    );
    expect(presenceEntry(ownerView, memberCid)!.currentRoomId).toBe(r3);
    expect(presenceEntry(memberView, memberCid)!.currentRoomId).toBe(r3);
  });

  it("an inaccessible or unknown currentRoomId is clamped to null and the ghost is omitted", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r2, r3]);
    const memberSock = await connectSettled(server, member.rawSessionId);
    const memberCid = connectionIdOf(memberSock);

    // A valid ghost first, so we can observe it being dropped.
    presenceUpdate(memberSock, r2);
    await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "presence_list" && !!presenceEntry(m, memberCid),
    );

    // R1 is a real room but NOT in the member's access → canAccess fails →
    // clamped to null → ghost omitted entirely. (An unknown id fails the
    // live-room check the same way.) The flip from r2 to null is a change, so
    // it rebroadcasts.
    const before = presenceCount(ownerSock);
    presenceUpdate(memberSock, r1);
    await waitForPresenceAfter(ownerSock, before, "inaccessible update");
    const lists = bag(ownerSock).filter((m) => m.type === "presence_list");
    expect(presenceEntry(lists[lists.length - 1], memberCid)).toBeUndefined();
  });

  it("a ghost in a room the recipient can't see is omitted for that recipient", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r2, r3]);
    const memberSock = await connectSettled(server, member.rawSessionId);
    const ownerCid = connectionIdOf(ownerSock);

    // Owner parks their ghost in R1 — a room the member has no access to. The
    // id is recipient-independent, but VISIBILITY is per-recipient: buildPresence
    // ListFor filters the owner's ghost out of the member's list.
    const before = presenceCount(memberSock);
    presenceUpdate(ownerSock, r1);
    await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "presence_list" &&
        presenceEntry(m, ownerCid)?.currentRoomId === r1,
    );
    await waitForPresenceAfter(memberSock, before, "owner parked in R1");
    const memberLists = bag(memberSock).filter(
      (m) => m.type === "presence_list",
    );
    expect(
      presenceEntry(memberLists[memberLists.length - 1], ownerCid),
    ).toBeUndefined();
  });

  it("reorder_rooms keeps the ghost's stable currentRoomId (no dense remap, not dropped)", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    const ownerCid = connectionIdOf(ownerSock);

    presenceUpdate(ownerSock, r1);
    await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "presence_list" &&
        presenceEntry(m, ownerCid)?.currentRoomId === r1,
    );

    // Reorder R1 to the end of the owner's view. Pre-cut this remapped a dense
    // index on the wire; post-cut the wire carries the stable id, so the ghost's
    // currentRoomId is UNCHANGED and the ghost is not dropped (the reorder still
    // rebroadcasts presence to the caller).
    const before = presenceCount(ownerSock);
    ownerSock.send({ type: "reorder_rooms", order: [r3, r2, r1] });
    await waitForPresenceAfter(ownerSock, before, "reorder");
    const lists = bag(ownerSock).filter((m) => m.type === "presence_list");
    expect(
      presenceEntry(lists[lists.length - 1], ownerCid)!.currentRoomId,
    ).toBe(r1);
  });
});
