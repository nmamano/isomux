// Phase 1.2 — Presence projection characterization.
//
// Presence is its own connectionId-keyed map (server/presence.ts) with a
// recipient-specific remap layered on top in server/index.ts: an inbound
// presence_update carries the sender's DENSE visible room index, which the
// server resolves through the sender's visibleRoomProjection back to a GLOBAL
// roomId (sanitized against allowedRooms, else null); the stored value is the
// global roomId, and presence_list re-emits it per recipient using each
// recipient's OWN dense index. This dense remap is exactly what 3c replaces
// (id-keyed wire), so it is frozen here, through the wire only.
//
// Determinism: a presence_update that changes visible state triggers a
// synchronous pushPresenceListToEachWs; value-based waiters (or a count-based
// wait when asserting an omission) settle without arbitrary sleeps.

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

function presenceUpdate(sock: TestSocket, currentRoom: number | null): void {
  sock.send({
    type: "presence_update",
    currentRoom,
    focusedAgentId: null,
    viewMode: "office",
  });
}

describe("presence projection — recipient-specific remap (Phase 1.2)", () => {
  it("a restricted member's dense index is stored as a global roomId and re-emitted per recipient", async () => {
    // Member sees [R2,R3] (R1 hidden) → their dense index 1 == global R3.
    // The owner (full access, initial order) sees the SAME room at its global
    // index 2; the member sees it at their dense index 1. The stored value is
    // the global roomId; the wire is always recipient-dense (this distinction
    // is what 3c's id-keyed wire makes explicit).
    server = await startTestServer();
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r2, r3]);
    const memberSock = await connectSettled(server, member.rawSessionId);
    const memberCid = connectionIdOf(memberSock);

    presenceUpdate(memberSock, 1); // member's dense index 1 → R3

    // Owner sees the member's ghost at the GLOBAL index of R3 (== 2 here only
    // because the owner is full-access and the order is the initial one).
    const ownerView = await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "presence_list" &&
        presenceEntry(m, memberCid)?.currentRoom === 2,
    );
    expect(presenceEntry(ownerView, memberCid)!.currentRoom).toBe(2);

    // The member sees their OWN ghost at their dense index 1 — same underlying
    // room (R3), different per-recipient index.
    const memberView = await waitForMessageWhere(
      memberSock,
      (m) =>
        m.type === "presence_list" &&
        presenceEntry(m, memberCid)?.currentRoom === 1,
    );
    expect(presenceEntry(memberView, memberCid)!.currentRoom).toBe(1);
  });

  it("an out-of-bounds / out-of-allowed index is clamped to null and the ghost is omitted from the wire", async () => {
    server = await startTestServer();
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r2, r3]);
    const memberSock = await connectSettled(server, member.rawSessionId);
    const memberCid = connectionIdOf(memberSock);

    // A valid ghost first, so we can observe it being dropped.
    presenceUpdate(memberSock, 0); // R2
    await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "presence_list" && !!presenceEntry(m, memberCid),
    );

    // Out-of-bounds dense index → clamped to null → ghost omitted entirely.
    const before = bag(ownerSock).filter(
      (m) => m.type === "presence_list",
    ).length;
    presenceUpdate(memberSock, 5);
    const deadline = Date.now() + 2000;
    while (
      bag(ownerSock).filter((m) => m.type === "presence_list").length <= before
    ) {
      if (Date.now() > deadline)
        throw new Error("no presence rebroadcast after OOB update");
      await sleep(5);
    }
    const lists = bag(ownerSock).filter((m) => m.type === "presence_list");
    expect(presenceEntry(lists[lists.length - 1], memberCid)).toBeUndefined();
  });

  it("reorder_rooms rebroadcasts presence with remapped indices while the global room identity is stable", async () => {
    // The stored currentRoomId (a global roomId) is untouched by reorder; only
    // the emitted dense index changes. Reorder chosen so the index DEFINITELY
    // differs (R1: index 0 → index 2).
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    const ownerCid = connectionIdOf(ownerSock);

    presenceUpdate(ownerSock, 0); // R1 at global index 0
    await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "presence_list" &&
        presenceEntry(m, ownerCid)?.currentRoom === 0,
    );

    // Move R1 to the end of the global order; the ghost's room is still R1.
    ownerSock.send({ type: "reorder_rooms", order: [r3, r2, r1] });
    const after = await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "presence_list" &&
        presenceEntry(m, ownerCid)?.currentRoom === 2,
    );
    // Same room (R1), new dense index (2) — the ghost was remapped, not dropped.
    expect(presenceEntry(after, ownerCid)!.currentRoom).toBe(2);
  });
});
