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
//   - GET mirrors the PUT's guard behavior exactly (200 { prompt, version } for
//     a reader who could write; owner + unknown id -> 404; member with no
//     access -> 403) and round-trips what the PUT saved (null when unset).
//   - Optimistic concurrency (task 44a2c98d, mirroring memory READ→REPLACE):
//     the GET returns a version over the prompt bytes; the PUT REQUIRES it
//     (missing -> 400 invalid_version), a stale version -> 409 version_conflict
//     carrying the CURRENT version, and neither failure writes or broadcasts.
//     Existence is checked before the version, so an unknown room stays 404.
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
  // The version from a preceding GET. `undefined` omits the field entirely
  // (the missing-version 400 case).
  version?: string,
): Promise<Res> {
  const res = await srv.http(`/api/rooms/${roomId}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      version === undefined ? { prompt } : { prompt, version },
    ),
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

// Read the current settings version the way a real writer does (GET first).
async function versionFor(
  srv: TestServer,
  roomId: string,
  rawSessionId: string,
): Promise<string> {
  const r = await getSettings(srv, roomId, rawSessionId);
  if (r.status !== 200) throw new Error(`versionFor -> ${r.status}`);
  return (r.body as { version: string }).version;
}

describe("rooms.setSettings REST (Phase 3d slice 6)", () => {
  it("owner save returns 204, persists the room prompt, and broadcasts room_settings_updated", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const sock = await srv.connectWs(owner.rawSessionId);
    const version = await versionFor(srv, room.id, owner.rawSessionId);
    const res = await putSettings(
      srv,
      room.id,
      "room prompt",
      owner.rawSessionId,
      version,
    );
    expect(res.status).toBe(204);
    expect(srv.agentManager.getRooms()[0].prompt).toBe("room prompt");
    await sock.waitFor("room_settings_updated");
  });

  it("owner + unknown room id -> 404 Room not found (rule access passes the guard, reaching the existence check; Follow-up #6)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    // Any version: existence is checked BEFORE the version guard, so an unknown
    // room is a 404, never a bogus version_conflict.
    const res = await putSettings(
      srv,
      "deadbeef",
      "x",
      owner.rawSessionId,
      "0123456789ab",
    );
    expect(res.status).toBe(404);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe(
      "room_not_found",
    );
  });

  it("member with no access -> 403 (uniform FORBIDDEN, no oracle), prompt untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const room = srv.agentManager.getRooms()[0];
    const version = await versionFor(srv, room.id, owner.rawSessionId);
    const res = await putSettings(
      srv,
      room.id,
      "y",
      member.rawSessionId,
      version,
    );
    expect(res.status).toBe(403);
    expect(srv.agentManager.getRooms()[0].prompt).toBeNull();
  });

  it("missing version -> 400 invalid_version, prompt untouched (write must carry the GET's version)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const res = await putSettings(srv, room.id, "x", owner.rawSessionId);
    expect(res.status).toBe(400);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe(
      "invalid_version",
    );
    expect(srv.agentManager.getRooms()[0].prompt).toBeNull();
  });

  it("stale version -> 409 version_conflict with the CURRENT version, nothing written or broadcast", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    // Writer A reads, then writer B saves — A's version is now stale.
    const staleVersion = await versionFor(srv, room.id, owner.rawSessionId);
    expect(
      (
        await putSettings(
          srv,
          room.id,
          "B's prompt",
          owner.rawSessionId,
          staleVersion,
        )
      ).status,
    ).toBe(204);
    const sock = await srv.connectWs(owner.rawSessionId);
    const res = await putSettings(
      srv,
      room.id,
      "A's clobber",
      owner.rawSessionId,
      staleVersion,
    );
    expect(res.status).toBe(409);
    const err = (res.body as { error?: { code?: string; version?: string } })
      .error;
    expect(err?.code).toBe("version_conflict");
    // The 409 carries the CURRENT version so the caller can re-read and retry.
    expect(err?.version).toBe(
      await versionFor(srv, room.id, owner.rawSessionId),
    );
    // Nothing written, nothing broadcast (no double-signal on the reject path).
    expect(srv.agentManager.getRooms()[0].prompt).toBe("B's prompt");
    await new Promise((r) => setTimeout(r, 150));
    expect(
      sock.messages.some(
        (m) => (m as { type?: string }).type === "room_settings_updated",
      ),
    ).toBe(false);
  });

  it("round-trip: the version returned by the post-save GET lets the next save through", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const v1 = await versionFor(srv, room.id, owner.rawSessionId);
    expect(
      (await putSettings(srv, room.id, "first", owner.rawSessionId, v1)).status,
    ).toBe(204);
    const v2 = await versionFor(srv, room.id, owner.rawSessionId);
    expect(v2).not.toBe(v1);
    expect(
      (await putSettings(srv, room.id, "second", owner.rawSessionId, v2))
        .status,
    ).toBe(204);
    expect(srv.agentManager.getRooms()[0].prompt).toBe("second");
  });
});

describe("rooms.getSettings REST (settings read pair)", () => {
  it("owner read -> 200 { prompt: null, version } before any save, then round-trips the PUT value", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const before = await getSettings(srv, room.id, owner.rawSessionId);
    expect(before.status).toBe(200);
    const beforeBody = before.body as {
      prompt: string | null;
      version: string;
    };
    expect(beforeBody.prompt).toBeNull();
    // The never-set prompt still versions (sha of "" — the missing-file
    // sentinel convention shared with memory versionOf).
    expect(beforeBody.version).toMatch(/^[0-9a-f]{12}$/);
    const put = await putSettings(
      srv,
      room.id,
      "room prompt",
      owner.rawSessionId,
      beforeBody.version,
    );
    expect(put.status).toBe(204);
    const after = await getSettings(srv, room.id, owner.rawSessionId);
    expect(after.status).toBe(200);
    const afterBody = after.body as { prompt: string | null; version: string };
    expect(afterBody.prompt).toBe("room prompt");
    expect(afterBody.version).toMatch(/^[0-9a-f]{12}$/);
    expect(afterBody.version).not.toBe(beforeBody.version);
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
