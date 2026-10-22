// Phase 3a slice 3a.6 - system.backupStatus on the unified REST surface.
// GET /api/backup/status (office:read + authenticated). Returns the NORMALIZED
// wire shape { lastRunAt, ok, error, retention, destDir } - a rename/projection
// of the internal BackupStatus (lastBackupOk null->false). The legacy
// GET /backup/status keeps its raw shape (a separate retained endpoint).
//
// Release-channel slice C1 adds system.version (GET /api/version, same auth
// posture). The unauthenticated GET /readyz probe is in
// routes-proxy-trust.test.ts.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
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
  it("answers the server's own status in the normalized shape to a member, refuses an agent, and the next boot gets a fresh default", async () => {
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
    await srv.seedOwner("First Morgan");
    const member = await srv.seedMember("Alice");
    const result = await api(srv, "/api/backup/status", {
      rawSessionId: member.rawSessionId,
    });
    // Renamed fields only: no internal name (lastBackupAt, backupDir,
    // running) reaches the wire.
    expect(result.body).toEqual({
      lastRunAt: 123,
      ok: false,
      error: "test failure",
      retention: 3,
      intervalHours: 12,
      destDir: "/isolated/backup-status",
      destDirFromEnv: true,
    });
    // AGENT scope lacks office:read.
    const agent = await spawnAgent(
      srv,
      "Worker",
      srv.agentManager.getRooms()[0].id,
    );
    expect(
      (
        await api(srv, "/api/backup/status", {
          bearer: getAgentTokenRaw(agent.id)!,
        })
      ).status,
    ).toBe(403);

    await srv.stop();
    server = null;
    srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Second Morgan");
    const fresh = (
      await api(srv, "/api/backup/status", {
        rawSessionId: owner.rawSessionId,
      })
    ).body as Record<string, unknown>;
    expect(fresh.lastRunAt).toBeNull();
    // lastBackupOk null -> false on a fresh install.
    expect(fresh.ok).toBe(false);
    expect(fresh.error).toBeNull();
    expect(fresh.destDir).toBe(`${srv.stateRoot}/test-backups`);
  });
});

// Backup settings (task e9776386). PUT /api/backup/settings is office:admin +
// owner, like storage.prune: it picks where the office's full archive goes.
// The field rules are pinned in backup.test.ts ("backup settings").
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

  it("refuses a member and a privileged agent, answers 400 for a bad value, and saves an owner's value", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Alice");
    const ops = await spawnAgent(srv, "Ops", srv.agentManager.getRooms()[0].id);
    await srv.agentManager.setPrivileged(ops.id, true);
    const put = (
      init: { rawSessionId?: string; bearer?: string },
      body: unknown,
    ) => api(srv, "/api/backup/settings", { method: "PUT", body, ...init });

    for (const who of [
      { rawSessionId: member.rawSessionId },
      { bearer: getAgentTokenRaw(ops.id)! },
    ])
      expect((await put(who, { retention: 2 })).status).toBe(403);
    for (const body of [{ intervalHours: "6" }, { dir: "relative/backups" }])
      expect({
        body,
        status: (await put({ rawSessionId: owner.rawSessionId }, body)).status,
      }).toEqual({ body, status: 400 });
    expect(loadBackupSettings()).toEqual(DEFAULT_BACKUP_SETTINGS);

    const root = mkdtempSync(join(tmpdir(), "isomux-backup-settings-"));
    dirs.push(root);
    const dir = join(root, "backups");
    const r = await put(
      { rawSessionId: owner.rawSessionId },
      { intervalHours: 6, retention: 3, dir },
    );
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
  });
});

describe("routes/system.version REST", () => {
  it("user and agent -> 200 {version, commit, release}", async () => {
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
  });
});
