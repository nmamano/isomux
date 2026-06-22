// Phase 3a slice 3a.5 — office.{getSettings,setSettings} on the unified REST
// surface. Owner-only (office:admin + officeOwner).
//
// What this freezes:
//   - getSettings returns the FULL OfficeSettings incl envFile (owner-only by
//     guard); member/agent 403; no identity 401.
//   - setSettings validates COMPLETELY before mutate/emit: an invalid env path or
//     over-long name returns 400 and does NOT mutate state or emit (no double-
//     signal). Valid save 204 + persists + emits office_settings_updated.
//   - name omitted-vs-null at the REST boundary (shared core with the WS arm).
//   - WS parity: the legacy update_office_settings arm goes through the SAME
//     applyOfficeSettings core.
//
// KNOWN-LEAK BRIDGE (do NOT "fix" by accident): office_settings_updated still
// broadcasts envFile to every browser via the legacy broadcast(event) bridge.
// Dropping envFile from this all-event is a deferred, UI-coordinated migration
// (the owner UI currently reads envFile from this payload), filed as a Follow-up.
// The test below asserts the bridge STILL carries envFile so a future
// liveEmit-conversion that drops it is a conscious, reviewed change — not a silent
// regression mistaken for a missed strangler conversion.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo, OfficeSettings } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "cond",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

describe("routes/office.getSettings REST", () => {
  it("owner -> 200 full settings incl envFile; member/agent -> 403; no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    // Seed an envFile so we can confirm it is exposed to the owner.
    srv.agentManager.setOfficeSettings("P", "/opt/office.env", "Acme");

    const r = await api(srv, "/api/office/settings", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    const s = r.body as OfficeSettings;
    expect(s.prompt).toBe("P");
    expect(s.name).toBe("Acme");
    expect(s.envFile).toBe("/opt/office.env");

    expect(
      (
        await api(srv, "/api/office/settings", {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(srv, "/api/office/settings", { bearer: token })).status,
    ).toBe(403);
    expect((await api(srv, "/api/office/settings")).status).toBe(401);
  });
});

describe("routes/office.setSettings REST", () => {
  it("owner valid save -> 204, persists, broadcasts office_settings_updated (bridge still carries envFile)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock = await srv.connectWs(owner.rawSessionId);

    const envPath = join(srv.stateRoot, "office.env");
    writeFileSync(envPath, "K=v\n");

    const r = await api(srv, "/api/office/settings", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { prompt: "office prompt", envFile: envPath, name: "Acme" },
    });
    expect(r.status).toBe(204);

    const s = srv.agentManager.getOfficeSettings();
    expect(s.prompt).toBe("office prompt");
    expect(s.envFile).toBe(envPath);
    expect(s.name).toBe("Acme");

    // 3b.5 CLOSED the deferred leak: the all-audience office_settings_updated no
    // longer carries envFile (owner-only; owners read it via full_state /
    // office.getSettings). The broadcast carries {name, prompt} only.
    await waitUntil(
      () =>
        sock.messages.some(
          (m) => (m as { type?: string }).type === "office_settings_updated",
        ),
      2000,
      "office_settings_updated broadcast",
    );
    const evt = sock.messages.find(
      (m) => (m as { type?: string }).type === "office_settings_updated",
    ) as { name?: string; prompt?: string; envFile?: string };
    expect(evt.name).toBe("Acme");
    expect(evt.prompt).toBe("office prompt");
    expect(evt.envFile).toBeUndefined(); // 3b.5: envFile no longer rides the all-event
  });

  it("invalid env path -> 400 and NO double-signal (state untouched, no broadcast)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock = await srv.connectWs(owner.rawSessionId);

    const r = await api(srv, "/api/office/settings", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { prompt: "nope", envFile: "./relative.env", name: null },
    });
    expect(r.status).toBe(400);
    // State untouched: validation ran BEFORE any mutation.
    expect(srv.agentManager.getOfficeSettings().prompt).toBeNull();
    // No emit on the invalid path (no double-signal).
    await sleep(150);
    expect(
      sock.messages.some(
        (m) => (m as { type?: string }).type === "office_settings_updated",
      ),
    ).toBe(false);
  });

  it("name over 60 chars -> 400, state untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r = await api(srv, "/api/office/settings", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { prompt: "p", envFile: null, name: "x".repeat(61) },
    });
    expect(r.status).toBe(400);
    expect(srv.agentManager.getOfficeSettings().name).toBeNull();
  });

  it("name omitted preserves; explicit null clears (shared core, mirrors WS arm)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");

    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { prompt: "P1", envFile: null, name: "KeepMe" },
        })
      ).status,
    ).toBe(204);

    // Omit `name` entirely -> current name preserved.
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { prompt: "P2", envFile: null },
        })
      ).status,
    ).toBe(204);
    expect(srv.agentManager.getOfficeSettings().name).toBe("KeepMe");

    // Explicit null -> cleared.
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { prompt: "P3", envFile: null, name: null },
        })
      ).status,
    ).toBe(204);
    expect(srv.agentManager.getOfficeSettings().name).toBeNull();
  });

  it("member/agent -> 403; no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          rawSessionId: member.rawSessionId,
          body: { prompt: "x", envFile: null },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          bearer: token,
          body: { prompt: "x", envFile: null },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          body: { prompt: "x", envFile: null },
        })
      ).status,
    ).toBe(401);
    // Owner-only write never mutated.
    expect(srv.agentManager.getOfficeSettings().prompt).toBeNull();
  });
});

describe("routes/office.setSettings: WS parity (shared core)", () => {
  it("legacy update_office_settings goes through applyOfficeSettings: same validation + persist", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock: TestSocket = await srv.connectWs(owner.rawSessionId);

    // Valid save via WS.
    sock.send({
      type: "update_office_settings",
      prompt: "via ws",
      name: "WsName",
      requestId: "w1",
    });
    const okResp = (await sock.waitFor("settings_save_response")) as {
      ok?: boolean;
    };
    expect(okResp.ok).toBe(true);
    expect(srv.agentManager.getOfficeSettings().prompt).toBe("via ws");
    expect(srv.agentManager.getOfficeSettings().name).toBe("WsName");

    // Invalid env path via WS -> same core rejection, no mutation of prompt.
    sock.send({
      type: "update_office_settings",
      prompt: "should not stick",
      envFile: "./relative.env",
      requestId: "w2",
    });
    await waitUntil(
      () =>
        sock.messages.some(
          (m) =>
            (m as { type?: string; requestId?: string }).type ===
              "settings_save_response" &&
            (m as { requestId?: string }).requestId === "w2",
        ),
      2000,
      "w2 ack",
    );
    const errResp = sock.messages.find(
      (m) =>
        (m as { type?: string; requestId?: string }).type ===
          "settings_save_response" &&
        (m as { requestId?: string }).requestId === "w2",
    ) as { ok?: boolean };
    expect(errResp.ok).toBe(false);
    expect(srv.agentManager.getOfficeSettings().prompt).toBe("via ws");
  });
});
