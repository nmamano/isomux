// office.{updateInfo,triggerUpdate} — GET/POST /api/office/update on the
// unified REST surface (release-channel in-UI update slice). Owner-only
// (office:admin + officeOwner), like the rest of the office-admin routes.
//
// The conf path is pinned via ISOMUX_UPDATE_CONF per test, so a real
// /etc/isomux/update.conf on the host can never leak in. The POST is only
// exercised on paths that refuse BEFORE any launch (not managed / invalid
// tag): the launch itself is systemd-shaped and lives behind the injected
// runner seam covered by server/update-trigger.test.ts — no test may ever
// run a real systemctl/systemd-run. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
let dir: string | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env.ISOMUX_UPDATE_CONF;
});

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  method: "GET" | "POST",
  init: { rawSessionId?: string; bearer?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http("/api/office/update", {
    method,
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

describe("routes/office.updateInfo REST", () => {
  it("owner -> 200 {managed:false} on an unmanaged box; member/agent -> 403; no id -> 401", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-upd-rest-"));
    process.env.ISOMUX_UPDATE_CONF = join(dir, "missing.conf");
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    const r = await api(srv, "GET", { rawSessionId: owner.rawSessionId });
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown>;
    expect(b.managed).toBe(false);
    expect(b.serviceKind).toBeNull();
    // Office-wide mid-turn count, server-computed (never the caller's room
    // projection). The freshly spawned harness agent is idle.
    expect(typeof b.busyAgents).toBe("number");
    // The checker status rides along (commit mode in the harness — no conf,
    // and the checker itself is skipped so it's the quiet initial value).
    expect((b.status as Record<string, unknown>).updateAvailable).toBe(false);

    expect(
      (await api(srv, "GET", { rawSessionId: member.rawSessionId })).status,
    ).toBe(403);
    expect((await api(srv, "GET", { bearer: token })).status).toBe(403);
    expect((await api(srv, "GET")).status).toBe(401);
  });

  it("owner -> 200 {managed:true, serviceKind} when an update.conf exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-upd-rest-"));
    const conf = join(dir, "update.conf");
    writeFileSync(conf, "SERVICE_KIND=user\nUPDATER_PATH=/x/isomux-update\n");
    process.env.ISOMUX_UPDATE_CONF = conf;
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");

    const r = await api(srv, "GET", { rawSessionId: owner.rawSessionId });
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown>;
    expect(b.managed).toBe(true);
    expect(b.serviceKind).toBe("user");
  });

  it("present-but-damaged conf -> managed:true with serviceKind:null (never commit-mode fallback)", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-upd-rest-"));
    const conf = join(dir, "update.conf");
    writeFileSync(conf, "not a key value line\n");
    process.env.ISOMUX_UPDATE_CONF = conf;
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");

    const r = await api(srv, "GET", { rawSessionId: owner.rawSessionId });
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown>;
    expect(b.managed).toBe(true);
    expect(b.serviceKind).toBeNull();

    // And the trigger refuses with a config error, not "not managed".
    const p = await api(srv, "POST", {
      rawSessionId: owner.rawSessionId,
      body: { tag: "v2026.7.19" },
    });
    expect(p.status).toBe(409);
    expect((p.body as { error: { code: string } }).error.code).toBe("bad_conf");
  });
});

async function waitUntil(
  cond: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("office.updateInfo busyAgents is office-wide", () => {
  it("a room-restricted owner still gets the count from rooms hidden to them", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-upd-rest-"));
    process.env.ISOMUX_UPDATE_CONF = join(dir, "missing.conf");
    // A backend whose sends never complete: the agent parks mid-turn.
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { onSend: () => {} } }),
    });
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const visibleRoom = srv.agentManager.getRooms()[0];
    const hiddenRoomId = srv.agentManager.createRoom("Hidden");
    const agent = await spawnAgent(srv, "HiddenWorker", hiddenRoomId);
    // Restrict the owner's view to the first room only — the busy agent lives
    // in a room this owner cannot see, so a client-store count would be 0.
    const ownerId = getUserByName("Boss")!.id;
    updateUserById(ownerId, { allowedRooms: [visibleRoom.id] });

    const r = srv.agentManager.enqueueMessage(agent.id, {
      sender: { kind: "user", username: "Boss" },
      text: "park mid-turn",
    });
    if (!r.ok) throw new Error(`enqueue failed: ${r.error}`);
    await waitUntil(
      () => {
        const s = srv.agentManager.getAgent(agent.id)?.state;
        return s === "thinking" || s === "tool_executing";
      },
      3000,
      "hidden agent parked mid-turn",
    );

    const res = await api(srv, "GET", { rawSessionId: owner.rawSessionId });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).busyAgents).toBe(1);
  });
});

describe("update_status hydration on WS connect", () => {
  it("every connection gets the full status, including updateAvailable=false", async () => {
    // The stale-banner regression: a browser that reconnects after an update
    // (or after the banner cleared) must receive the authoritative false
    // state — hydration only-when-true would leave the old banner up forever.
    dir = mkdtempSync(join(tmpdir(), "isomux-upd-rest-"));
    process.env.ISOMUX_UPDATE_CONF = join(dir, "missing.conf");
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");

    const ws = await srv.connectWs(owner.rawSessionId);
    const msg = await ws.waitFor("update_status");
    expect(msg.updateAvailable).toBe(false);
    expect(msg.mode).toBe("commit");
    ws.close();
  });
});

describe("routes/office.triggerUpdate REST", () => {
  it("owner on an unmanaged box -> 409 not_managed; bad tag -> 400; member/agent -> 403", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-upd-rest-"));
    process.env.ISOMUX_UPDATE_CONF = join(dir, "missing.conf");
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    const refused = await api(srv, "POST", {
      rawSessionId: owner.rawSessionId,
      body: { tag: "v2026.7.19" },
    });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      "not_managed",
    );

    // Tag validation refuses before anything conf-dependent runs. A missing
    // tag is a 400 from the handler; a malformed one from the plan.
    expect(
      (
        await api(srv, "POST", {
          rawSessionId: owner.rawSessionId,
          body: {},
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await api(srv, "POST", {
          rawSessionId: member.rawSessionId,
          body: { tag: "v2026.7.19" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "POST", {
          bearer: token,
          body: { tag: "v2026.7.19" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(srv, "POST", { body: { tag: "v2026.7.19" } })).status,
    ).toBe(401);
  });

  it("managed box, malformed tag -> 400 invalid_tag (still nothing launched)", async () => {
    dir = mkdtempSync(join(tmpdir(), "isomux-upd-rest-"));
    const conf = join(dir, "update.conf");
    writeFileSync(conf, "SERVICE_KIND=system\n");
    process.env.ISOMUX_UPDATE_CONF = conf;
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");

    const r = await api(srv, "POST", {
      rawSessionId: owner.rawSessionId,
      body: { tag: "main" },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe(
      "invalid_tag",
    );
  });
});
