// Phase 3a slice 3a.5 - backends.listModels on the unified REST surface.
// GET /api/backends/:agentType/models?cwd=&includeHidden= (agent:manage +
// authenticated). The shared core (listBackendModels) backed the legacy
// list_backend_models WS arm, retired in 3d slice 2. Claude's listModels is a
// static, offline family list, so this is deterministic and zero-LLM.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import type { BackendModelWire } from "../../shared/types.ts";

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
  init: { rawSessionId?: string } = {},
): Promise<Res> {
  const res = await srv.http(path, {
    method: "GET",
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

describe("routes/backends.listModels REST", () => {
  // The capability (agent:manage, which an agent token lacks) is pinned in
  // routes-table.test.ts and identity-tokens.test.ts.
  it("an owner gets the static claude family list with a default", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const path = `/api/backends/claude/models?cwd=${encodeURIComponent(srv.stateRoot)}`;

    const r = await api(srv, path, { rawSessionId: owner.rawSessionId });
    expect(r.status).toBe(200);
    const models = (r.body as { models: BackendModelWire[] }).models;
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.isDefault)).toBe(true);
  });

  it("unknown agentType -> 200 with empty models + authError:false (graceful, via the core catch)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
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
