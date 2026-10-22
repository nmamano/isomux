// Phase 3a slice 3a.6 - system.backupStatus on the unified REST surface.
// GET /api/backup/status (office:read + authenticated). Returns the NORMALIZED
// wire shape { lastRunAt, ok, error, retention, destDir } - a rename/projection
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
import { mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_BACKUP_SETTINGS,
  loadBackupSettings,
  saveBackupSettings,
} from "../backup.ts";
import { removeStateDir } from "./temp-state.ts";
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
  init: {
    rawSessionId?: string;
    bearer?: string;
    method?: string;
    body?: unknown;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
    const owner = await srv.seedOwner("Morgan");
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

  it("uses per-server internal status and the next boot gets a fresh default", async () => {
    let srv = await startTestServer({
      startServer: {
        getBackupStatus: () => ({
          backupDir: "/isolated/backup-status",
          backupDirFromEnv: true,
          retention: 3,
          intervalHours: 12,
          lastBackupAt: 123,
          lastBackupOk: false,
          lastBackupError: "test failure",
          lastBackupFile: null,
          running: true,
        }),
      },
    });
    server = srv;
    let owner = await srv.seedOwner("First Morgan");
    let result = await api(srv, "/api/backup/status", {
      rawSessionId: owner.rawSessionId,
    });
    expect(result.body).toEqual({
      lastRunAt: 123,
      ok: false,
      error: "test failure",
      retention: 3,
      intervalHours: 12,
      destDir: "/isolated/backup-status",
      destDirFromEnv: true,
    });

    await srv.stop();
    server = null;
    srv = await startTestServer();
    server = srv;
    owner = await srv.seedOwner("Second Morgan");
    result = await api(srv, "/api/backup/status", {
      rawSessionId: owner.rawSessionId,
    });
    const body = result.body as Record<string, unknown>;
    expect(body.lastRunAt).toBeNull();
    expect(body.ok).toBe(false);
    expect(body.error).toBeNull();
    expect(body.destDir).toBe(`${srv.stateRoot}/test-backups`);
  });
});

// Backup settings (task e9776386). PUT /api/backup/settings is office:admin +
// owner, like storage.prune: it picks where the office's full archive goes.
describe("routes/system.setBackupSettings REST", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    // Stop first: a failing reset must not leave the harness running for the
    // next describe.
    await server?.stop();
    server = null;
    while (dirs.length > 0) removeStateDir(dirs.pop()!);
    saveBackupSettings({ ...DEFAULT_BACKUP_SETTINGS }, { envDir: undefined });
  });

  it("owner saves and gets the new status back; no backup runs in a test boot", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const root = mkdtempSync(join(tmpdir(), "isomux-backup-settings-"));
    dirs.push(root);
    const dir = join(root, "backups");

    const r = await api(srv, "/api/backup/settings", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { intervalHours: 6, retention: 3, dir },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      intervalHours: 6,
      retention: 3,
      destDir: dir,
      destDirFromEnv: false,
    });
    expect(typeof (r.body as Record<string, unknown>).oldBackupsDir).toBe(
      "string",
    );
    expect(loadBackupSettings()).toEqual({
      intervalHours: 6,
      retention: 3,
      dir,
    });
    // The save asks the scheduler for a check, and a test boot has none.
    await Bun.sleep(200);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tar.gz"))).toEqual([]);
  });

  it("rejects a malformed or refused value with 400 and saves nothing", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    for (const body of [
      { intervalHours: 0 },
      { intervalHours: "6" },
      { retention: 1.5 },
      { dir: 5 },
      { dir: "relative/backups" },
      { dir: srv.stateRoot },
    ]) {
      const r = await api(srv, "/api/backup/settings", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        body,
      });
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
    }
    expect(loadBackupSettings()).toEqual(DEFAULT_BACKUP_SETTINGS);
  });

  it("member -> 403, privileged agent -> 403, no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const ops = await spawnAgent(srv, "Ops", room.id);
    await srv.agentManager.setPrivileged(ops.id, true);
    const body = { retention: 2 };
    const put = (init: { rawSessionId?: string; bearer?: string }) =>
      api(srv, "/api/backup/settings", { method: "PUT", body, ...init });

    expect((await put({ rawSessionId: member.rawSessionId })).status).toBe(403);
    expect((await put({ bearer: getAgentTokenRaw(ops.id)! })).status).toBe(403);
    expect((await put({})).status).toBe(401);
    expect(loadBackupSettings().retention).toBe(
      DEFAULT_BACKUP_SETTINGS.retention,
    );
  });
});

describe("routes/system.version REST", () => {
  it("user -> 200 {version, commit, release}; agent -> 200; no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
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
    // checkout may have a release tag at HEAD. The human-readable version
    // also reports tracked changes, while the pinned release does not.
    expect(typeof b.commit).toBe("string");
    expect(typeof b.version).toBe("string");
    const release = b.release as string | null;
    if (release !== null) {
      expect((b.version as string).replace(/-dirty$/, "")).toBe(release);
    }

    expect((await api(srv, "/api/version", { bearer: token })).status).toBe(
      200,
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

    await srv.seedOwner("Morgan");
    const post = await srv.http("/readyz", { method: "GET" });
    expect(post.status).toBe(200);
    expect(await post.text()).toBe("ok\n");
  });
});
