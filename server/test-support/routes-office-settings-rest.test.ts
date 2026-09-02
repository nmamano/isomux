// Phase 3a slice 3a.5 - office.{getSettings,setSettings} on the unified REST
// surface. Owner-only (office:admin + officeOwner).
//
// What this freezes:
//   - getSettings returns the FULL OfficeSettings incl envFile (owner-only by
//     guard) plus the optimistic-concurrency `version` over the whole blob;
//     member/agent 403; no identity 401.
//   - setSettings validates COMPLETELY before mutate/emit: an invalid env path or
//     over-long name returns 400 and does NOT mutate state or emit (no double-
//     signal). Valid save 204 + persists + emits office_settings_updated.
//   - name omitted-vs-null at the REST boundary: omitting preserves the current
//     name, explicit null clears it (the validate-then-apply core's semantics).
//   - Optimistic concurrency (task 44a2c98d, mirroring memory READ→REPLACE):
//     the PUT REQUIRES the version from a preceding GET (missing -> 400
//     invalid_version); a stale version -> 409 version_conflict carrying the
//     CURRENT version, checked BEFORE field validation (a stale writer is told
//     to re-read first), and neither failure writes or emits. One version
//     guards the whole blob (the PUT replaces prompt/envFile/name wholesale).
//
// KNOWN-LEAK BRIDGE (do NOT "fix" by accident): office_settings_updated still
// broadcasts envFile to every browser via the legacy broadcast(event) bridge.
// Dropping envFile from this all-event is a deferred, UI-coordinated migration
// (the owner UI currently reads envFile from this payload), filed as a Follow-up.
// The test below asserts the bridge STILL carries envFile so a future
// liveEmit-conversion that drops it is a conscious, reviewed change - not a silent
// regression mistaken for a missed strangler conversion.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
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

// Read the current settings version the way a real writer does (GET first).
async function officeVersion(
  srv: TestServer,
  rawSessionId: string,
): Promise<string> {
  const r = await api(srv, "/api/office/settings", { rawSessionId });
  if (r.status !== 200) throw new Error(`officeVersion -> ${r.status}`);
  return (r.body as { version: string }).version;
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
  it("owner -> 200 without envFile; member/agent -> 403; no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    // A legacy migration marker is no longer exposed on the settings wire.
    srv.agentManager.setOfficeSettings("P", "/opt/office.env", "Acme");

    const r = await api(srv, "/api/office/settings", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    const s = r.body as OfficeSettings & { version: string };
    expect(s.prompt).toBe("P");
    expect(s.name).toBe("Acme");
    expect(s.envFile).toBeUndefined();
    // Optimistic-concurrency version over the whole blob, required by the PUT.
    expect(s.version).toMatch(/^[0-9a-f]{12}$/);

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
  it("owner valid save -> 204, ignores stale envFile, and broadcasts", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    srv.agentManager.setOfficeSettings(null, "/legacy/office.env", null);
    const sock = await srv.connectWs(owner.rawSessionId);

    const version = await officeVersion(srv, owner.rawSessionId);
    const r = await api(srv, "/api/office/settings", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: {
        prompt: "office prompt",
        envFile: "/stale/tab.env",
        name: "Acme",
        version,
      },
    });
    expect(r.status).toBe(204);

    const s = srv.agentManager.getOfficeSettings();
    expect(s.prompt).toBe("office prompt");
    expect(s.envFile).toBe("/legacy/office.env");
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

  it("name over 60 chars -> 400, state untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const version = await officeVersion(srv, owner.rawSessionId);
    const r = await api(srv, "/api/office/settings", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { prompt: "p", envFile: null, name: "x".repeat(61), version },
    });
    expect(r.status).toBe(400);
    expect(srv.agentManager.getOfficeSettings().name).toBeNull();
  });

  it("missing version -> 400 invalid_version, state untouched (write must carry the GET's version)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r = await api(srv, "/api/office/settings", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { prompt: "p", envFile: null },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error?: { code?: string } }).error?.code).toBe(
      "invalid_version",
    );
    expect(srv.agentManager.getOfficeSettings().prompt).toBeNull();
  });

  it("stale version -> 409 version_conflict with the CURRENT version, nothing written or emitted (checked before field validation)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    // Writer A reads, then writer B saves - A's version is now stale.
    const staleVersion = await officeVersion(srv, owner.rawSessionId);
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: {
            prompt: "B's prompt",
            envFile: null,
            name: "B",
            version: staleVersion,
          },
        })
      ).status,
    ).toBe(204);
    const sock = await srv.connectWs(owner.rawSessionId);
    // A's write also carries an INVALID env path: the version guard runs first,
    // so the stale writer hears 409 (re-read), not 400 (fix your env path).
    const r = await api(srv, "/api/office/settings", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: {
        prompt: "A's clobber",
        envFile: "./relative.env",
        name: "A",
        version: staleVersion,
      },
    });
    expect(r.status).toBe(409);
    const err = (r.body as { error?: { code?: string; version?: string } })
      .error;
    expect(err?.code).toBe("version_conflict");
    // The 409 carries the CURRENT version so the caller can re-read and retry.
    expect(err?.version).toBe(await officeVersion(srv, owner.rawSessionId));
    // Nothing written, nothing emitted.
    const s = srv.agentManager.getOfficeSettings();
    expect(s.prompt).toBe("B's prompt");
    expect(s.name).toBe("B");
    await sleep(150);
    expect(
      sock.messages.some(
        (m) => (m as { type?: string }).type === "office_settings_updated",
      ),
    ).toBe(false);
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
          body: {
            prompt: "P1",
            envFile: null,
            name: "KeepMe",
            version: await officeVersion(srv, owner.rawSessionId),
          },
        })
      ).status,
    ).toBe(204);

    // Omit `name` entirely -> current name preserved.
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: {
            prompt: "P2",
            envFile: null,
            version: await officeVersion(srv, owner.rawSessionId),
          },
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
          body: {
            prompt: "P3",
            envFile: null,
            name: null,
            version: await officeVersion(srv, owner.rawSessionId),
          },
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

    // The guard rejects before the version shape check, so any version works.
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          rawSessionId: member.rawSessionId,
          body: { prompt: "x", envFile: null, version: "0123456789ab" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          bearer: token,
          body: { prompt: "x", envFile: null, version: "0123456789ab" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/office/settings", {
          method: "PUT",
          body: { prompt: "x", envFile: null, version: "0123456789ab" },
        })
      ).status,
    ).toBe(401);
    // Owner-only write never mutated.
    expect(srv.agentManager.getOfficeSettings().prompt).toBeNull();
  });
});
