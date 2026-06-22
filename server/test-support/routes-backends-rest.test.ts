// Phase 3a slice 3a.5 — backends.listModels on the unified REST surface.
// GET /api/backends/:agentType/models?cwd=&includeHidden= (agent:manage +
// authenticated). The shared core (listBackendModels) backed the legacy
// list_backend_models WS arm, retired in 3d slice 2. Claude's listModels is a
// static, offline family list, so this is deterministic and zero-LLM.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo, BackendModelWire } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  path: string,
  init: { rawSessionId?: string; bearer?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: "GET",
    headers,
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

describe("routes/backends.listModels REST", () => {
  it("owner + member -> 200 with the static claude family list; agent -> 403; no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    const path = `/api/backends/claude/models?cwd=${encodeURIComponent(srv.stateRoot)}`;

    const r = await api(srv, path, { rawSessionId: owner.rawSessionId });
    expect(r.status).toBe(200);
    const models = (r.body as { models: BackendModelWire[] }).models;
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.isDefault)).toBe(true);

    // agent:manage is held by any USER (member included).
    expect(
      (await api(srv, path, { rawSessionId: member.rawSessionId })).status,
    ).toBe(200);
    // AGENT scope lacks agent:manage.
    expect((await api(srv, path, { bearer: token })).status).toBe(403);
    expect((await api(srv, path)).status).toBe(401);
  });

  it("unknown agentType -> 200 with empty models + authError:false (graceful, via the core catch)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r = await api(srv, "/api/backends/bogus/models", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      models: BackendModelWire[];
      authError?: boolean;
      error?: string;
    };
    expect(body.models).toEqual([]);
    expect(body.authError).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});
