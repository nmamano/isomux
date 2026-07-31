// Phase 3d slice 6 - rooms.create / rooms.close / rooms.rename REST contract.
//
// HTTP-contract layer for the room-structure mutations cut over from WS in slice
// 6. Pins status codes + guard behavior:
//   - create: room:manage is a USER capability (agents lack it) and the guard is
//     `authenticated`, so any user (owner OR member) creates -> 201 { room };
//     no identity -> 401. The member-creator grant + the per-recipient
//     projection of room_created live in projection.test.ts.
//   - close/rename: guarded by requiresRoomAccess(:roomId). An owner reaches an
//     unknown id by rule and gets the core's 404 "Room not found" (Follow-up #6);
//     a member without access gets the uniform 403 (no exists-vs-hidden oracle).
//   - rename rejects an empty name with 422 (a body shape check, never an
//     existence oracle).
//
// The emitted events' per-recipient ACL (room_created grant catch-up, the bare
// room_closed delta, the close-cleanup allowedRooms strip) are frozen in
// projection.test.ts. Seam: startTestServer() - real auth + /api executor. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

async function req(
  srv: TestServer,
  method: string,
  path: string,
  init: { body?: unknown; rawSessionId?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    rawSessionId: init.rawSessionId,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const errCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } }).error?.code;

describe("rooms.create REST (Phase 3d slice 6)", () => {
  it("owner -> 201 { room } with a real id present in getRooms()", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const before = srv.agentManager.getRooms().length;
    const res = await req(srv, "POST", "/api/rooms", {
      body: { name: "NewRoom" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(201);
    const room = (res.body as { room?: { id?: string; name?: string } }).room;
    expect(typeof room?.id).toBe("string");
    expect(room?.name).toBe("NewRoom");
    const rooms = srv.agentManager.getRooms();
    expect(rooms.length).toBe(before + 1);
    expect(rooms.some((r) => r.id === room!.id)).toBe(true);
  });

  it("a member can create (room:manage is a user capability) -> 201", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const res = await req(srv, "POST", "/api/rooms", {
      body: {},
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(201);
  });

  it("no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const res = await req(srv, "POST", "/api/rooms", { body: { name: "X" } });
    expect(res.status).toBe(401);
  });
});

describe("rooms.close REST (Phase 3d slice 6)", () => {
  it("owner closes an empty room -> 204; room removed", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const extra = srv.agentManager.createRoom("Extra");
    const res = await req(srv, "DELETE", `/api/rooms/${extra}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
    expect(srv.agentManager.getRooms().some((r) => r.id === extra)).toBe(false);
  });

  it("owner + unknown room id -> 404 room_not_found (Follow-up #6)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await req(srv, "DELETE", "/api/rooms/deadbeef", {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(404);
    expect(errCode(res.body)).toBe("room_not_found");
  });

  it("member with no access -> 403; room untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const extra = srv.agentManager.createRoom("Extra");
    const res = await req(srv, "DELETE", `/api/rooms/${extra}`, {
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(403);
    expect(srv.agentManager.getRooms().some((r) => r.id === extra)).toBe(true);
  });
});

describe("rooms.rename REST (Phase 3d slice 6)", () => {
  it("owner rename -> 204; name changes", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const id = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "PATCH", `/api/rooms/${id}`, {
      body: { name: "Renamed" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
    expect(srv.agentManager.getRooms()[0].name).toBe("Renamed");
  });

  it("empty/whitespace name -> 422 invalid_name (shape check, not an existence oracle)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const id = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "PATCH", `/api/rooms/${id}`, {
      body: { name: "   " },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_name");
  });

  it("owner + unknown room id -> 404 room_not_found", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await req(srv, "PATCH", "/api/rooms/deadbeef", {
      body: { name: "Z" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(404);
    expect(errCode(res.body)).toBe("room_not_found");
  });

  it("member with no access -> 403", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const id = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "PATCH", `/api/rooms/${id}`, {
      body: { name: "Z" },
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(403);
  });
});
