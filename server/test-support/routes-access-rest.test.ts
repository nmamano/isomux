// Phase 3a slice 3a.4c - Access settings on the unified REST surface
// (opIds office.{getAccess,setAccess}). Owner-only; closes 3a.4.
//
// What this freezes:
//   - getAccess returns the five-field AccessSettings; owner-only (member/agent
//     403, no identity 401).
//   - setAccess enable persists config, returns {signInUrl, restartRequired},
//     mints the owner self-invite, and fans out a scoped invites_list (double-
//     signal). Disable persists false/null and mints no signInUrl.
//   - Status mapping: invalid origin 400, enable-without-origin 400, env mismatch
//     409 (config NOT changed), owner-only 403/401.
//   - WS parity: the legacy update_access_settings arm goes through the SAME
//     shared core (applyAccessSettings) - returns the richer access_settings_updated
//     and emits invites_list - so the REST extraction can't drift from the WS path.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { loadServerConfig } from "../persistence.ts";
import { STATE_ROOT } from "../config.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo, InviteWire } from "../../shared/types.ts";
import type { AccessSettings } from "../../shared/contract-shapes.ts";

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

describe("routes/office access REST: getAccess", () => {
  it("reports outside reachability instead of the proxy-fronted socket bind", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    writeFileSync(
      join(STATE_ROOT, "office-config.json"),
      JSON.stringify({
        externalAccess: true,
        publicOrigin: "https://office.example",
        networkBind: "loopback",
      }),
    );
    const restarted = await srv.restart();
    server = restarted;

    const r = await api(restarted, "/api/office/access", {
      rawSessionId: owner.rawSessionId,
    });
    const access = r.body as AccessSettings;
    expect(access.externalAccess).toBe(true);
    expect(access.boundLoopback).toBe(false);
  });

  it("owner -> 200 with all five fields; member/agent -> 403; no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    const r = await api(srv, "/api/office/access", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    const a = r.body as AccessSettings;
    expect(a.externalAccess).toBe(false); // fresh: no config, no env
    expect(a.publicOrigin).toBe(null);
    expect(a.envOriginSet).toBe(false);
    expect(a.envOrigin).toBe(null);
    expect(typeof a.boundLoopback).toBe("boolean");

    expect(
      (
        await api(srv, "/api/office/access", {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(srv, "/api/office/access", { bearer: token })).status,
    ).toBe(403);
    expect((await api(srv, "/api/office/access")).status).toBe(401);
  });
});

describe("routes/office access REST: setAccess", () => {
  it("preserves the deployment-authored networkBind setting", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const configPath = join(STATE_ROOT, "office-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ networkBind: "loopback" }, null, 2),
    );

    const r = await api(srv, "/api/office/access", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { externalAccess: true, publicOrigin: "https://office.example" },
    });

    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).networkBind).toBe(
      "loopback",
    );
  });

  it("enable: 200 {signInUrl, restartRequired}, persists, mints owner self-invite, fans out invites_list", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ownerSock = await srv.connectWs(owner.rawSessionId);

    const r = await api(srv, "/api/office/access", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { externalAccess: true, publicOrigin: "https://office.example" },
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      signInUrl: string | null;
      restartRequired: boolean;
    };
    expect(body.restartRequired).toBe(true);
    expect(body.signInUrl?.startsWith("https://office.example/i/")).toBe(true);

    // Persisted.
    const cfg = loadServerConfig();
    expect(cfg.externalAccess).toBe(true);
    expect(cfg.publicOrigin).toBe("https://office.example");

    // Owner self-invite minted + visible.
    const invites = (
      (await api(srv, "/api/invites", { rawSessionId: owner.rawSessionId }))
        .body as { invites: InviteWire[] }
    ).invites;
    expect(invites.some((i) => i.username === "Boss")).toBe(true);

    // Double-signal: the connected owner received the scoped invites_list fanout.
    await waitUntil(
      () =>
        ownerSock.messages.some(
          (m) => (m as { type?: string }).type === "invites_list",
        ),
      2000,
      "owner invites_list fanout",
    );
  });

  it("disable: 200, persists false/null, no signInUrl", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r = await api(srv, "/api/office/access", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { externalAccess: false, publicOrigin: "" },
    });
    expect(r.status).toBe(200);
    expect((r.body as { signInUrl: string | null }).signInUrl).toBe(null);
    const cfg = loadServerConfig();
    expect(cfg.externalAccess).toBe(false);
    expect(cfg.publicOrigin).toBe(null);
  });

  it("invalid origin -> 400; enable-without-origin -> 400; member/agent -> 403; no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    expect(
      (
        await api(srv, "/api/office/access", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { externalAccess: true, publicOrigin: "not-a-url/path" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(srv, "/api/office/access", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { externalAccess: true, publicOrigin: "" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(srv, "/api/office/access", {
          method: "PUT",
          rawSessionId: member.rawSessionId,
          body: { externalAccess: false, publicOrigin: "" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/office/access", {
          method: "PUT",
          bearer: token,
          body: { externalAccess: false, publicOrigin: "" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/office/access", {
          method: "PUT",
          body: { externalAccess: false, publicOrigin: "" },
        })
      ).status,
    ).toBe(401);
  });

  it("enable against a conflicting ISOMUX_PUBLIC_ORIGIN env -> 409, config NOT changed", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const before = loadServerConfig();
    const prevEnv = process.env.ISOMUX_PUBLIC_ORIGIN;
    process.env.ISOMUX_PUBLIC_ORIGIN = "https://env.example";
    try {
      const r = await api(srv, "/api/office/access", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        body: { externalAccess: true, publicOrigin: "https://typed.example" },
      });
      expect(r.status).toBe(409);
      expect((r.body as { error?: { code?: string } }).error?.code).toBe(
        "set_access_failed",
      );
      // The save is gated BEFORE persistence - config is untouched.
      const after = loadServerConfig();
      expect(after.externalAccess).toBe(before.externalAccess);
      expect(after.publicOrigin).toBe(before.publicOrigin);
    } finally {
      if (prevEnv === undefined) delete process.env.ISOMUX_PUBLIC_ORIGIN;
      else process.env.ISOMUX_PUBLIC_ORIGIN = prevEnv;
    }
  });
});
