// Phase 3a slice 3a.6 — system.backupStatus on the unified REST surface.
// GET /api/backup/status (office:read + authenticated). Returns the NORMALIZED
// wire shape { lastRunAt, ok, error, retention, destDir } — a rename/projection
// of the internal BackupStatus (lastBackupOk null->false). The legacy
// GET /backup/status keeps its raw shape (a separate retained endpoint).
//
// Release-channel slice C1 adds system.version (GET /api/version, same auth
// posture) and the unauthenticated GET /readyz probe (limiter behavior is
// pinned separately in server/ready-limiter.test.ts; the harness connects
// over loopback, which is exempt).
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo } from "../../shared/types.ts";

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

describe("routes/system.backupStatus REST", () => {
  it("owner + member -> 200 normalized shape; agent -> 403; no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    const r = await api(srv, "/api/backup/status", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown>;
    // Normalized field names (rename), and the null->false coercion on a fresh
    // install (no backup has run yet).
    expect(b).toHaveProperty("lastRunAt");
    expect(b).toHaveProperty("ok");
    expect(b).toHaveProperty("error");
    expect(typeof b.retention).toBe("number");
    expect(typeof b.destDir).toBe("string");
    expect(b.ok).toBe(false); // lastBackupOk null -> false
    // The internal raw field names must NOT leak into the /api shape.
    expect(b).not.toHaveProperty("lastBackupAt");
    expect(b).not.toHaveProperty("backupDir");
    expect(b).not.toHaveProperty("running");

    // office:read is held by any USER (member included).
    expect(
      (
        await api(srv, "/api/backup/status", {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(200);
    // AGENT scope lacks office:read.
    expect(
      (await api(srv, "/api/backup/status", { bearer: token })).status,
    ).toBe(403);
    expect((await api(srv, "/api/backup/status")).status).toBe(401);
  });
});

describe("routes/system.version REST", () => {
  it("user -> 200 {version, commit, release}; agent -> 403; no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    const r = await api(srv, "/api/version", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(["commit", "release", "version"]);
    // The test process runs from a real checkout, so git resolves; the dev
    // checkout has no release tag at HEAD (and if one ever exists, release
    // equals version — assert the invariant, not the tag).
    expect(typeof b.commit).toBe("string");
    expect(typeof b.version).toBe("string");
    if (b.release !== null) expect(b.release).toBe(b.version as string);

    expect((await api(srv, "/api/version", { bearer: token })).status).toBe(
      403,
    );
    expect((await api(srv, "/api/version")).status).toBe(401);
  });
});

describe("GET /readyz", () => {
  it("answers 200 'ok' with no identity, before and after claim", async () => {
    const srv = await startTestServer();
    server = srv;
    // Pre-claim (no owner seeded yet): the probe must not be behind the
    // cookie wall or the claim gate.
    const pre = await srv.http("/readyz", { method: "GET" });
    expect(pre.status).toBe(200);
    expect(await pre.text()).toBe("ok\n");

    await srv.seedOwner("Boss");
    const post = await srv.http("/readyz", { method: "GET" });
    expect(post.status).toBe(200);
    expect(await post.text()).toBe("ok\n");
  });
});
