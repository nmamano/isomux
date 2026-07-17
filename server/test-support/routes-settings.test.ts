// Phase 3d slice 6 — rooms.setSettings REST characterization, plus the later
// rooms.getSettings read (GET /api/rooms/:roomId/settings — the settings pair
// shares one ACL, so both live here).
//
// The room-prompt save moved from the WS update_room_settings command (deleted
// in slice 6) to PUT /api/rooms/:roomId/settings (rooms.setSettings). This file
// freezes the REST behavior:
//   - owner save persists the prompt and broadcasts room_settings_updated;
//   - owner + unknown room id -> 404 "Room not found". Under rule-based access
//     canAccess(owner, anyId) is true, so the requiresRoomAccess guard passes and
//     the core's existence check is reachable (doc Follow-up #6). Not a leak: an
//     owner already sees every real room, so disclosing non-existence reveals
//     nothing hidden.
//   - member with no access -> 403 (the uniform FORBIDDEN; no exists-vs-hidden
//     oracle), prompt untouched.
//   - GET mirrors the PUT's guard behavior exactly (200 { prompt } for a
//     reader who could write; owner + unknown id -> 404; member with no
//     access -> 403) and round-trips what the PUT saved (null when unset).
//
// The room-structure mutations (create/close/rename) are in
// routes-rooms-rest.test.ts; the per-recipient projection/ACL of these events is
// in projection.test.ts.
//
// Seam: startTestServer() — real auth + /api executor, plus a WS socket to
// observe the broadcast. Zero LLM.

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

async function getSettings(
  srv: TestServer,
  roomId: string,
  rawSessionId: string,
): Promise<Res> {
  const res = await srv.http(`/api/rooms/${roomId}/settings`, {
    method: "GET",
    rawSessionId,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function putSettings(
  srv: TestServer,
  roomId: string,
  prompt: string | null,
  rawSessionId: string,
): Promise<Res> {
  const res = await srv.http(`/api/rooms/${roomId}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
    rawSessionId,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe("rooms.setSettings REST (Phase 3d slice 6)", () => {
  it("owner save returns 204, persists the room prompt, and broadcasts room_settings_updated", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const sock = await srv.connectWs(owner.rawSessionId);
    const res = await putSettings(
      srv,
      room.id,
      "room prompt",
      owner.rawSessionId,
    );
    expect(res.status).toBe(204);
    expect(srv.agentManager.getRooms()[0].prompt).toBe("room prompt");
    await sock.waitFor("room_settings_updated");
  });

  it("owner + unknown room id -> 404 Room not found (rule access passes the guard, reaching the existence check; Follow-up #6)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await putSettings(srv, "deadbeef", "x", owner.rawSessionId);
    expect(res.status).toBe(404);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe(
      "room_not_found",
    );
  });

  it("member with no access -> 403 (uniform FORBIDDEN, no oracle), prompt untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const room = srv.agentManager.getRooms()[0];
    const res = await putSettings(srv, room.id, "y", member.rawSessionId);
    expect(res.status).toBe(403);
    expect(srv.agentManager.getRooms()[0].prompt).toBeNull();
  });
});

describe("rooms.getSettings REST (settings read pair)", () => {
  it("owner read -> 200 { prompt: null } before any save, then round-trips the PUT value", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const before = await getSettings(srv, room.id, owner.rawSessionId);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ prompt: null });
    const put = await putSettings(
      srv,
      room.id,
      "room prompt",
      owner.rawSessionId,
    );
    expect(put.status).toBe(204);
    const after = await getSettings(srv, room.id, owner.rawSessionId);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ prompt: "room prompt" });
  });

  it("owner + unknown room id -> 404 room_not_found (mirrors the PUT; Follow-up #6)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await getSettings(srv, "deadbeef", owner.rawSessionId);
    expect(res.status).toBe(404);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe(
      "room_not_found",
    );
  });

  it("member with no access -> 403 (uniform FORBIDDEN, no oracle)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const room = srv.agentManager.getRooms()[0];
    const res = await getSettings(srv, room.id, member.rawSessionId);
    expect(res.status).toBe(403);
  });
});
