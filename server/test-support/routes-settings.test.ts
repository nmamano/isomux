// Phase 1.4(b) — Room settings command characterization.
//
// update_room_settings is the remaining WebSocket settings command (rooms get
// strangled onto rooms.setSettings in a later 3d slice). The office-settings WS
// arm (update_office_settings) was retired when the UI cut over to
// office.setSettings; its characterization now lives in
// routes-office-settings-rest.test.ts (REST behavior + shared-core parity).
// projection.test.ts freezes the update_user room-access slice; this file
// freezes the room-prompt slice.
//
// Boundary = the settings_save_response ack (matched by requestId — the harness
// waitFor only filters by type, so a stale buffered ack would otherwise be
// returned) AND the room_settings_updated broadcast, with agentManager room
// state as persistence confirmation.
//
// Notable current behavior frozen here:
//   - update_room_settings checks ACCESS before existence, so an unknown room
//     id returns "You don't have access to that room" even for an owner — the
//     "Room not found" branch is effectively unreachable via this command.
//
// Seam: startTestServer() WS sockets. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

interface SaveResp {
  type: string;
  requestId: string;
  ok?: boolean;
  error?: string;
}

let ridSeq = 0;

// Send a settings command and resolve with the settings_save_response carrying
// the SAME requestId — never just the first response of that type (the harness
// waitFor matches type only, so a buffered earlier ack would race in).
async function settingsCmd(
  sock: TestSocket,
  cmd: Record<string, unknown>,
): Promise<SaveResp> {
  const requestId = `req-${++ridSeq}`;
  sock.send({ ...cmd, requestId });
  const find = () =>
    sock.messages.find(
      (m) =>
        (m as SaveResp).type === "settings_save_response" &&
        (m as SaveResp).requestId === requestId,
    ) as SaveResp | undefined;
  await waitUntil(() => !!find(), 2000, `settings_save_response ${requestId}`);
  return find()!;
}

describe("routes/settings: room settings (access-gated) (Phase 1.4b)", () => {
  it("owner update succeeds, persists the room prompt, and broadcasts room_settings_updated", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const sock = await srv.connectWs(owner.rawSessionId);
    const resp = await settingsCmd(sock, {
      type: "update_room_settings",
      roomId: room.id,
      prompt: "room prompt",
    });
    expect(resp.ok).toBe(true);
    expect(srv.agentManager.getRooms()[0].prompt).toBe("room prompt");
    await sock.waitFor("room_settings_updated");
  });

  it("rule-based owner access: an unknown room id now PASSES the owner gate (rule) and reaches the existence check -> Room not found (3b flip; was unreachable under materialized access)", async () => {
    // 3b FLIP. Under materialized access an owner's allowedRooms never contained
    // an unknown id, so the access check rejected first ("You don't have access")
    // and the "Room not found" branch was DEAD (doc Follow-up 6). Rule-based
    // access grants an owner EVERY room id by rule — including a nonexistent one
    // — so the access gate passes and the existence check is now reachable. Not
    // a leak: an owner can already see every real room, so distinguishing
    // "doesn't exist" reveals nothing hidden. (Members are unchanged: an unknown
    // id still fails their grant check -> "You don't have access" -> no oracle.)
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock = await srv.connectWs(owner.rawSessionId);
    const resp = await settingsCmd(sock, {
      type: "update_room_settings",
      roomId: "deadbeef",
      prompt: "x",
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("Room not found");
  });

  it("a member with no access to the room is rejected", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const room = srv.agentManager.getRooms()[0];
    const sock = await srv.connectWs(member.rawSessionId);
    const resp = await settingsCmd(sock, {
      type: "update_room_settings",
      roomId: room.id,
      prompt: "y",
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("You don't have access to that room.");
    // Room prompt untouched.
    expect(srv.agentManager.getRooms()[0].prompt).toBeNull();
  });
});
