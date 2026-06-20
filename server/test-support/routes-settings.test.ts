// Phase 1.4(b) — Office / room settings command characterization.
//
// These are WebSocket commands (update_office_settings / update_room_settings),
// not HTTP routes — but the Phase 1.4 net (build-order item 8) explicitly lists
// "settings", and they are the current transport surface Phase 3 strangles onto
// office.setSettings / rooms.setSettings. They are characterized here in their
// CURRENT command form: this file is included because settings are part of the
// current transport surface, not because it is HTTP. projection.test.ts already
// freezes the update_user (room-access) slice; these settings slices were
// uncovered.
//
// Boundary = the settings_save_response ack (matched by requestId — the harness
// waitFor only filters by type, so a stale buffered ack would otherwise be
// returned) AND the broadcast event, with agentManager office/room state as
// persistence confirmation.
//
// Notable current behaviors frozen here:
//   - Office settings are owner-only; a member is rejected at the command.
//   - Name length is capped at 60; an absolute env path is required (a relative
//     path is rejected deterministically, touching no real home).
//   - Name omitted-vs-null: omitting `name` preserves the current name; an
//     explicit null/empty clears it. (A stale client tab omits the field.)
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

describe("routes/settings: office settings (owner-only) (Phase 1.4b)", () => {
  it("owner update succeeds, persists, and broadcasts office_settings_updated", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock = await srv.connectWs(owner.rawSessionId);
    const resp = await settingsCmd(sock, {
      type: "update_office_settings",
      prompt: "office prompt",
      name: "Acme Office",
    });
    expect(resp.ok).toBe(true);
    // Persistence confirmation.
    const settings = srv.agentManager.getOfficeSettings();
    expect(settings.prompt).toBe("office prompt");
    expect(settings.name).toBe("Acme Office");
    // Broadcast confirmation (office settings are not room-scoped).
    await sock.waitFor("office_settings_updated");
  });

  it("a member is rejected -> Only owners can edit office settings", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const sock = await srv.connectWs(member.rawSessionId);
    const resp = await settingsCmd(sock, {
      type: "update_office_settings",
      prompt: "nope",
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("Only owners can edit office settings.");
    // Office state untouched.
    expect(srv.agentManager.getOfficeSettings().prompt).toBeNull();
  });

  it("name over 60 chars is rejected", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock = await srv.connectWs(owner.rawSessionId);
    const resp = await settingsCmd(sock, {
      type: "update_office_settings",
      name: "x".repeat(61),
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("Office name must be 60 characters or fewer");
  });

  it("a relative env path is rejected (must be absolute) without touching home", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock = await srv.connectWs(owner.rawSessionId);
    const resp = await settingsCmd(sock, {
      type: "update_office_settings",
      envFile: "./does-not-exist.env",
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("env file path must be absolute");
  });

  it("name omitted-vs-null: omitting preserves, explicit null clears (the fragile slice)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock = await srv.connectWs(owner.rawSessionId);
    // Establish a name. Primary signal is the ack; state is confirmation.
    const established = await settingsCmd(sock, {
      type: "update_office_settings",
      prompt: "P1",
      name: "KeepMe",
    });
    expect(established.ok).toBe(true);
    // Omit `name` while changing prompt -> name preserved (stale-tab safety).
    const omitted = await settingsCmd(sock, {
      type: "update_office_settings",
      prompt: "P2",
    });
    expect(omitted.ok).toBe(true);
    expect(srv.agentManager.getOfficeSettings().name).toBe("KeepMe");
    // Explicit null -> cleared.
    const nulled = await settingsCmd(sock, {
      type: "update_office_settings",
      prompt: "P3",
      name: null,
    });
    expect(nulled.ok).toBe(true);
    expect(srv.agentManager.getOfficeSettings().name).toBeNull();
  });
});

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

  it("an unknown room id fails the access check first -> You don't have access (Room not found is unreachable)", async () => {
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
    expect(resp.error).toBe("You don't have access to that room.");
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
