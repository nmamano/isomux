// The automatic log cleanup's settings on the REST surface (task 3f8db20b).
//
// GET /api/storage/retention  office:read + authenticated, like backup status:
//                             the two ages, the keep-newest floor, the last run.
// PUT /api/storage/retention  office:admin + officeOwner, like the backup
//                             settings: validates every field before it writes.
//
// The harness boots against a temp state root and runs no scheduler, so no
// cleanup runs here. Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
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
  body: Record<string, unknown> | null;
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
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
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
    srv.workDir,
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

const ages = (b: Record<string, unknown> | null) => ({
  compressAfterDays: b?.compressAfterDays,
  deleteAfterDays: b?.deleteAfterDays,
});

describe("GET /api/storage/retention", () => {
  it("a fresh office compresses after 7 days, deletes nothing and never ran; members read it, a plain agent cannot", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Alice");
    const expected = {
      compressAfterDays: 7,
      deleteAfterDays: null,
      keepPerAgent: 2,
      lastRunAt: null,
      lastRun: null,
      lastError: null,
      running: false,
    };
    for (const who of [owner, member]) {
      const r = await api(srv, "/api/storage/retention", {
        rawSessionId: who.rawSessionId,
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual(expected);
    }
    const agent = await spawnAgent(
      srv,
      "Worker",
      srv.agentManager.getRooms()[0].id,
    );
    expect(
      (
        await api(srv, "/api/storage/retention", {
          bearer: getAgentTokenRaw(agent.id)!,
        })
      ).status,
    ).toBe(403);
  });

  it("reports the last run from the state file", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const lastRun = {
      compressed: 5,
      compressBytesSaved: 1234,
      transcriptsDeleted: 2,
      filesDeleted: 7,
      bytesDeleted: 9999,
    };
    writeFileSync(
      join(srv.stateRoot, "log-retention.json"),
      JSON.stringify({ lastRunAt: 1_700_000_000_000, lastRun, lastError: "e" }),
    );
    const r = await api(srv, "/api/storage/retention", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    expect(r.body!.lastRunAt).toBe(1_700_000_000_000);
    expect(r.body!.lastRun).toEqual(lastRun);
    expect(r.body!.lastError).toBe("e");
  });

  it("an unreadable state file reads as never run", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    writeFileSync(join(srv.stateRoot, "log-retention.json"), "{not json");
    const r = await api(srv, "/api/storage/retention", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    expect(r.body!.lastRunAt).toBeNull();
    expect(r.body!.lastRun).toBeNull();
  });

  it("an invalid stored age reads as its default", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const put = await api(srv, "/api/storage/retention", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { compressAfterDays: 3, deleteAfterDays: 60 },
    });
    expect(put.status).toBe(200);
    // A hand edit that breaks both values.
    const file = join(srv.stateRoot, "office-config.json");
    const config = JSON.parse(await Bun.file(file).text()) as Record<
      string,
      unknown
    >;
    expect(config.logsCompressAfterDays).toBe(3);
    expect(config.logsDeleteAfterDays).toBe(60);
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        logsCompressAfterDays: "3",
        logsDeleteAfterDays: 0,
      }),
    );
    const r = await api(srv, "/api/storage/retention", {
      rawSessionId: owner.rawSessionId,
    });
    expect(ages(r.body)).toEqual({
      compressAfterDays: 7,
      deleteAfterDays: null,
    });
  });
});

describe("PUT /api/storage/retention", () => {
  it("the owner sets both ages, an omitted field keeps its value, null turns deletes off, and the values survive a restart", async () => {
    let srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const put = (body: unknown) =>
      api(srv, "/api/storage/retention", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        body,
      });
    const get = async () =>
      ages(
        (
          await api(srv, "/api/storage/retention", {
            rawSessionId: owner.rawSessionId,
          })
        ).body,
      );

    const r = await put({ compressAfterDays: 14, deleteAfterDays: 90 });
    expect(r.status).toBe(200);
    expect(ages(r.body)).toEqual({
      compressAfterDays: 14,
      deleteAfterDays: 90,
    });
    expect(await get()).toEqual({ compressAfterDays: 14, deleteAfterDays: 90 });

    expect((await put({ compressAfterDays: 1 })).status).toBe(200);
    expect(await get()).toEqual({ compressAfterDays: 1, deleteAfterDays: 90 });

    expect((await put({ deleteAfterDays: 3650 })).status).toBe(200);
    expect(await get()).toEqual({
      compressAfterDays: 1,
      deleteAfterDays: 3650,
    });

    expect((await put({ deleteAfterDays: null })).status).toBe(200);
    expect(await get()).toEqual({
      compressAfterDays: 1,
      deleteAfterDays: null,
    });

    expect(
      (await put({ compressAfterDays: 3650, deleteAfterDays: 1 })).status,
    ).toBe(200);
    srv = await srv.restart();
    server = srv;
    expect(await get()).toEqual({
      compressAfterDays: 3650,
      deleteAfterDays: 1,
    });
  });

  it("refuses each bad field with a 400 and writes nothing, not even the good field beside it", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const put = (body: unknown) =>
      api(srv, "/api/storage/retention", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        body,
      });
    expect(
      (await put({ compressAfterDays: 10, deleteAfterDays: 40 })).status,
    ).toBe(200);

    const bad: unknown[] = [
      { compressAfterDays: 0 },
      { compressAfterDays: 3651 },
      { compressAfterDays: 1.5 },
      { compressAfterDays: "7" },
      { compressAfterDays: null },
      { deleteAfterDays: 0 },
      { deleteAfterDays: 3651 },
      { deleteAfterDays: 2.5 },
      { deleteAfterDays: "30" },
      { deleteAfterDays: false },
      // The good field must not be written when the other is bad.
      { compressAfterDays: 20, deleteAfterDays: 0 },
      { compressAfterDays: 0, deleteAfterDays: 20 },
    ];
    for (const body of bad) {
      const r = await put(body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
      expect({
        body,
        code: (r.body?.error as { code?: string } | undefined)?.code,
      }).toEqual({ body, code: "invalid_retention_settings" });
    }
    // Not an object: the executor may refuse it before the handler, with its
    // own code.
    for (const body of [[1, 2], "7"]) {
      const r = await put(body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
    }
    const after = await api(srv, "/api/storage/retention", {
      rawSessionId: owner.rawSessionId,
    });
    expect(ages(after.body)).toEqual({
      compressAfterDays: 10,
      deleteAfterDays: 40,
    });
  });

  it("a member and a privileged agent are refused", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Alice");
    const ops = await spawnAgent(srv, "Ops", srv.agentManager.getRooms()[0].id);
    await srv.agentManager.setPrivileged(ops.id, true);
    for (const who of [
      { rawSessionId: member.rawSessionId },
      { bearer: getAgentTokenRaw(ops.id)! },
    ]) {
      const r = await api(srv, "/api/storage/retention", {
        method: "PUT",
        body: { deleteAfterDays: 1 },
        ...who,
      });
      expect(r.status).toBe(403);
    }
    const r = await api(srv, "/api/storage/retention", {
      rawSessionId: owner.rawSessionId,
    });
    expect(ages(r.body)).toEqual({
      compressAfterDays: 7,
      deleteAfterDays: null,
    });
  });

  // The harness answers backup status from a fixed fake, so the file is the
  // evidence: the other keys of office-config.json survive a retention save.
  it("keeps the other settings that share the config file", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const file = join(srv.stateRoot, "office-config.json");
    const before = existsSync(file)
      ? (JSON.parse(await Bun.file(file).text()) as Record<string, unknown>)
      : {};
    writeFileSync(
      file,
      JSON.stringify({
        ...before,
        backupIntervalHours: 12,
        backupRetention: 5,
      }),
    );
    expect(
      (
        await api(srv, "/api/storage/retention", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { compressAfterDays: 30, deleteAfterDays: 365 },
        })
      ).status,
    ).toBe(200);
    const after = JSON.parse(await Bun.file(file).text()) as Record<
      string,
      unknown
    >;
    expect(after).toEqual({
      ...before,
      backupIntervalHours: 12,
      backupRetention: 5,
      logsCompressAfterDays: 30,
      logsDeleteAfterDays: 365,
    });
  });

  // A save takes effect at the next daily run; it does not start one.
  it("a save does not run the cleanup", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const dir = join(srv.stateRoot, "logs", "agent-ghost");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "old.jsonl");
    writeFileSync(old, '{"id":"1"}\n');
    const aged = (Date.now() - 400 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, aged, aged);

    const r = await api(srv, "/api/storage/retention", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { compressAfterDays: 1, deleteAfterDays: 1 },
    });
    expect(r.status).toBe(200);
    await Bun.sleep(50);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(`${old}.gz`)).toBe(false);
    const get = await api(srv, "/api/storage/retention", {
      rawSessionId: owner.rawSessionId,
    });
    expect(get.body!.lastRunAt).toBeNull();
  });
});
