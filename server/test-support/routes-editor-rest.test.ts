// Phase 3d slice 6b — editor REST contract.
//
// HTTP-contract layer for the browser editor (open/save/close) cut over from the
// WS command bus. Pins status codes + the connection-binding security: open/close
// require an X-Isomux-Connection-Id header that names a live socket owned by the
// caller's EXACT session, so a client can't aim a file-watch / external-change
// push at another tab's socket. saveFile's 409 stale-conflict carries currentMtime
// past the error envelope (via the executor's detail spread).
//
// Seam: startTestServer() — real auth + the /api executor + a real temp cwd, so
// openFile reads actual bytes off disk.

import { describe, it, expect, afterEach } from "bun:test";
import {
  writeFileSync,
  readFileSync,
  statSync,
  mkdirSync,
  unlinkSync,
  utimesSync,
} from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

// HTTP with an optional connection header + cookie.
async function req(
  srv: TestServer,
  method: string,
  path: string,
  init: {
    body?: unknown;
    rawSessionId?: string;
    connectionId?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.connectionId !== undefined)
    headers["X-Isomux-Connection-Id"] = init.connectionId;
  const res = await srv.http(path, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
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

const errCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } }).error?.code;

// Connect a WS and read this tab's connectionId off session_context — the value
// the editor's open/close carry in X-Isomux-Connection-Id.
async function connect(
  srv: TestServer,
  rawSessionId: string,
): Promise<{ sock: TestSocket; connectionId: string }> {
  const sock = await srv.connectWs(rawSessionId);
  await sock.waitFor("session_context");
  const ctx = sock.messages.find(
    (m) => (m as { type?: string }).type === "session_context",
  ) as { context?: { connectionId?: string } } | undefined;
  return { sock, connectionId: ctx?.context?.connectionId ?? "" };
}

async function spawnAt(srv: TestServer, name: string, roomId: string) {
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    0,
    undefined,
    roomId,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

describe("agents.openFile REST (Phase 3d slice 6b)", () => {
  it("owner GET -> 200 with { path, content, mtime, language, size }", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    mkdirSync(srv.stateRoot, { recursive: true });
    const file = join(srv.stateRoot, "hello.ts");
    writeFileSync(file, "export const x = 1;\n", "utf8");
    const { connectionId } = await connect(srv, owner.rawSessionId);

    const res = await req(srv, "GET", `/api/agents/${x.id}/file?path=${file}`, {
      rawSessionId: owner.rawSessionId,
      connectionId,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      path: string;
      content: string;
      language: string;
    };
    expect(body.path).toBe(file);
    expect(body.content).toContain("export const x");
    expect(body.language).toBe("javascript");
  });

  it("non-existent path -> 404", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const { connectionId } = await connect(srv, owner.rawSessionId);
    const res = await req(
      srv,
      "GET",
      `/api/agents/${x.id}/file?path=${join(srv.stateRoot, "nope.txt")}`,
      { rawSessionId: owner.rawSessionId, connectionId },
    );
    expect(res.status).toBe(404);
  });

  it("missing X-Isomux-Connection-Id header -> 400", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(
      srv,
      "GET",
      `/api/agents/${x.id}/file?path=${join(srv.stateRoot, "a.txt")}`,
      { rawSessionId: owner.rawSessionId },
    );
    expect(res.status).toBe(400);
    expect(errCode(res.body)).toBe("missing_connection");
  });

  it("a connectionId not owned by the caller's session -> 403 bad_connection", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    // The owner clears the agentParam guard (room access), but a connectionId
    // that names no socket of theirs fails verifyConnection — the SAME exact-
    // session check that blocks aiming a watch at another tab's socket.
    const res = await req(
      srv,
      "GET",
      `/api/agents/${x.id}/file?path=${join(srv.stateRoot, "a.txt")}`,
      { rawSessionId: owner.rawSessionId, connectionId: "not-my-connection" },
    );
    expect(res.status).toBe(403);
    expect(errCode(res.body)).toBe("bad_connection");
  });
});

describe("agents.saveFile REST (Phase 3d slice 6b)", () => {
  it("owner PUT -> 200 { ok, mtime } and the bytes land on disk", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const file = join(srv.stateRoot, "save.txt");
    writeFileSync(file, "old\n", "utf8");
    const mtime = Math.floor(statSync(file).mtimeMs);

    const res = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: { path: file, content: "new\n", expectedMtime: mtime },
    });
    expect(res.status).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
    expect(typeof (res.body as { mtime?: number }).mtime).toBe("number");
  });

  it("stale write -> 409 stale with currentMtime in the envelope", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const file = join(srv.stateRoot, "stale.txt");
    writeFileSync(file, "disk\n", "utf8");
    const current = Math.floor(statSync(file).mtimeMs);

    // expectedMtime older than the disk's -> the concurrency guard refuses.
    const res = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: { path: file, content: "mine\n", expectedMtime: current - 1000 },
    });
    expect(res.status).toBe(409);
    expect(errCode(res.body)).toBe("stale");
    // currentMtime rides the error envelope (the executor's detail spread).
    expect(
      (res.body as { error?: { currentMtime?: number } }).error?.currentMtime,
    ).toBe(current);
  });

  it("missing path -> 400; non-number expectedMtime -> 422", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const missingPath = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: { content: "x", expectedMtime: 0 },
    });
    expect(missingPath.status).toBe(400);
    const badMtime = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: { path: "/tmp/x", content: "x", expectedMtime: "soon" },
    });
    expect(badMtime.status).toBe(422);
  });

  it("non-boolean force -> 422 and the file is NOT overwritten", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const file = join(srv.stateRoot, "force.txt");
    writeFileSync(file, "original\n", "utf8");
    const current = Math.floor(statSync(file).mtimeMs);
    // A truthy non-boolean force would, under `?? false`, force-overwrite past the
    // stale guard. The handler must reject it at the boundary, untouched.
    const res = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: {
        path: file,
        content: "hacked\n",
        expectedMtime: current - 1000, // stale
        force: "false",
      },
    });
    expect(res.status).toBe(422);
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });

  it("non-finite expectedMtime (Infinity) -> 422", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    // JSON.stringify can't carry Infinity (-> null), so hand-craft the body: the
    // server's JSON.parse turns 1e999 into Infinity, and `currentMtime > Infinity`
    // is false — Number.isFinite at the boundary blocks that stale-guard bypass.
    const p = join(srv.stateRoot, "inf.txt");
    const res = await srv.http(`/api/agents/${x.id}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: `{"path":${JSON.stringify(p)},"content":"x","expectedMtime":1e999}`,
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
  });

  it("non-finite expectedRev (Infinity) -> 422", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const p = join(srv.stateRoot, "inf-rev.txt");
    const res = await srv.http(`/api/agents/${x.id}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: `{"path":${JSON.stringify(p)},"content":"x","expectedMtime":0,"expectedRev":1e999}`,
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
  });
});

// Editor file lifecycle (tasks 1ed49547 + 259224b6): the wire-level revision
// on open/save, and the distinct deleted-conflict on save.
describe("editor revision + deletion contract", () => {
  it("open returns rev; save with that rev -> 200 { ok, mtime, rev }", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const file = join(srv.stateRoot, "rev.txt");
    writeFileSync(file, "v0\n", "utf8");
    const { connectionId } = await connect(srv, owner.rawSessionId);

    const open = await req(
      srv,
      "GET",
      `/api/agents/${x.id}/file?path=${file}`,
      { rawSessionId: owner.rawSessionId, connectionId },
    );
    expect(open.status).toBe(200);
    const opened = open.body as { mtime: number; rev: number };
    expect(typeof opened.rev).toBe("number");

    const save = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: {
        path: file,
        // Longer than "v0\n" so the write is a signature change even within
        // the same millisecond.
        content: "v1 with more bytes\n",
        expectedMtime: opened.mtime,
        expectedRev: opened.rev,
      },
    });
    expect(save.status).toBe(200);
    const saved = save.body as { ok: boolean; rev: number };
    expect(saved.ok).toBe(true);
    expect(saved.rev).toBeGreaterThan(opened.rev);
  });

  it("rev mismatch -> 409 stale even when mtime moved BACKWARDS (rollback)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const file = join(srv.stateRoot, "rollback.txt");
    writeFileSync(file, "v0\n", "utf8");
    const { connectionId } = await connect(srv, owner.rawSessionId);
    const open = await req(
      srv,
      "GET",
      `/api/agents/${x.id}/file?path=${file}`,
      { rawSessionId: owner.rawSessionId, connectionId },
    );
    expect(open.status).toBe(200);
    const opened = open.body as { mtime: number; rev: number };

    // External change whose mtime is OLDER than the open — the legacy
    // `currentMtime > expectedMtime` guard would let this save clobber it.
    writeFileSync(file, "restored older version\n", "utf8");
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);

    const save = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: {
        path: file,
        content: "mine\n",
        expectedMtime: opened.mtime,
        expectedRev: opened.rev,
      },
    });
    expect(save.status).toBe(409);
    expect(errCode(save.body)).toBe("stale");
    // currentRev rides the error envelope next to currentMtime.
    expect(
      typeof (save.body as { error?: { currentRev?: number } }).error
        ?.currentRev,
    ).toBe("number");
    expect(readFileSync(file, "utf8")).toBe("restored older version\n");
  });

  it("save on a deleted path -> 409 deleted; force recreates the file", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const file = join(srv.stateRoot, "gone.txt");
    writeFileSync(file, "v0\n", "utf8");
    const { connectionId } = await connect(srv, owner.rawSessionId);
    const open = await req(
      srv,
      "GET",
      `/api/agents/${x.id}/file?path=${file}`,
      { rawSessionId: owner.rawSessionId, connectionId },
    );
    expect(open.status).toBe(200);
    const opened = open.body as { mtime: number; rev: number };
    unlinkSync(file);

    const refused = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: {
        path: file,
        content: "recreated\n",
        expectedMtime: opened.mtime,
        expectedRev: opened.rev,
      },
    });
    expect(refused.status).toBe(409);
    expect(errCode(refused.body)).toBe("deleted");

    const forced = await req(srv, "PUT", `/api/agents/${x.id}/file`, {
      rawSessionId: owner.rawSessionId,
      body: {
        path: file,
        content: "recreated\n",
        expectedMtime: opened.mtime,
        expectedRev: opened.rev,
        force: true,
      },
    });
    expect(forced.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe("recreated\n");
  });
});

describe("agents.closeFile REST (Phase 3d slice 6b)", () => {
  it("owner DELETE -> 204 (no-op safe on an un-watched path)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const { connectionId } = await connect(srv, owner.rawSessionId);
    const res = await req(
      srv,
      "DELETE",
      `/api/agents/${x.id}/file/watch?path=${join(srv.stateRoot, "a.txt")}`,
      { rawSessionId: owner.rawSessionId, connectionId },
    );
    expect(res.status).toBe(204);
  });
});
