// Phase 1.4(b) — Agent self-affordance + upload + file-serving route characterization.
//
// Freezes the OBSERVABLE contract of the agent-facing HTTP affordances before
// Phase 3 strangles them onto the typed route table (opIds agents.readFile/
// diff/editFile/terminalCommand [retain, later token-authed]; agents.upload
// [strangle]; agents.getFile [behavior-change, later room-ACL-gated]).
//
// The message route (POST /agents/:id/message) is deliberately EXCLUDED: its
// 200/400/404/409/429 + dedupe/cap/reject matrix and body-trust senderAgentId
// are already frozen by queue.test.ts (Phase 1.4a). No overlap.
//
// Boundary = HTTP response (status + body) AND the WS log_entry the affordance
// emits into the agent's chat (kind + payload), asserted via waitUntil on a
// connected socket — never a sync read after an in-memory mutation (the
// WS-arrival race that flaked a 1.4a test).
//
// Key current behaviors frozen here:
//   - Affordance handlers return { ok:true } | { ok:false, status, error };
//     an UNKNOWN agent is a 404, but a bad/missing FILE is NOT an HTTP error —
//     it returns { ok:true } and surfaces a kind:"system" log entry instead.
//   - /api/upload and /api/files are NOT in isAgentApiPath, so they require a
//     cookie even from loopback (the agent affordances do not). Auth posture
//     itself is frozen in routes-auth; here we use a seeded owner cookie.
//   - Upload limits are 5 files / 200MB each / 400MB total in code today. We
//     freeze the cheap COUNT limit; the byte limits are intentionally NOT
//     exercised (allocating >200MB would bloat `bun test`).
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
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

// Wait for (and return) the first log_entry for `agentId` of the given kind.
// `contains` disambiguates kind:"system" (spawn emits an "Agent ready" system
// entry that is replayed on connect, so kind alone is not unique there).
async function waitForLog(
  sock: TestSocket,
  agentId: string,
  kind: LogEntry["kind"],
  contains?: string,
  timeoutMs = 2000,
): Promise<LogEntry> {
  const match = () =>
    sock.messages.find((m) => {
      const msg = m as { type?: string; entry?: LogEntry };
      return (
        msg.type === "log_entry" &&
        msg.entry?.agentId === agentId &&
        msg.entry?.kind === kind &&
        (contains === undefined || msg.entry.content.includes(contains))
      );
    }) as { entry: LogEntry } | undefined;
  await waitUntil(
    () => !!match(),
    timeoutMs,
    `log_entry kind=${kind}${contains ? ` ~ ${contains}` : ""}`,
  );
  return match()!.entry;
}

interface HttpResult {
  status: number;
  body: { ok?: boolean; error?: string; [k: string]: unknown };
}

// Agent affordances are loopback-trusted (/agents/ is in isAgentApiPath), so no
// cookie is needed; the harness fetches 127.0.0.1.
async function affordance(
  srv: TestServer,
  agentId: string,
  action: string,
  body: unknown,
): Promise<HttpResult> {
  const res = await srv.http(`/agents/${agentId}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as HttpResult["body"],
  };
}

describe("routes/affordances: read-file (Phase 1.4b)", () => {
  it("missing path -> 400 missing path", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    const r = await affordance(srv, a.id, "read-file", {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("missing path");
  });

  it("unknown agent (valid path) -> 404 agent not found", async () => {
    const srv = await startTestServer();
    server = srv;
    const r = await affordance(srv, "ghost", "read-file", { path: "/x" });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("agent not found");
  });

  it("existing file -> { ok:true } + kind:file-view log entry with attachment", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    writeFileSync(join(srv.stateRoot, "hello.txt"), "hi there");
    const sock = await srv.connectWs(owner.rawSessionId);
    const r = await affordance(srv, a.id, "read-file", { path: "hello.txt" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const entry = await waitForLog(sock, a.id, "file-view");
    expect(entry.attachments?.length).toBe(1);
  });

  it("nonexistent file is NOT an HTTP error -> { ok:true } + kind:system 'does not exist'", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    const sock = await srv.connectWs(owner.rawSessionId);
    const r = await affordance(srv, a.id, "read-file", { path: "nope.txt" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const entry = await waitForLog(sock, a.id, "system", "does not exist");
    expect(entry.content).toContain("does not exist");
  });
});

describe("routes/affordances: edit-file + terminal-command (Phase 1.4b)", () => {
  it("edit-file existing text file -> { ok:true } + kind:edit-request", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    writeFileSync(join(srv.stateRoot, "edit-me.txt"), "content");
    const sock = await srv.connectWs(owner.rawSessionId);
    const r = await affordance(srv, a.id, "edit-file", { path: "edit-me.txt" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const entry = await waitForLog(sock, a.id, "edit-request");
    expect(entry.file?.path).toContain("edit-me.txt");
  });

  it("edit-file missing path -> 400 missing path", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    const r = await affordance(srv, a.id, "edit-file", {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("missing path");
  });

  it("terminal-command single-line -> { ok:true } + kind:terminal-command", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    const sock = await srv.connectWs(owner.rawSessionId);
    const r = await affordance(srv, a.id, "terminal-command", {
      command: "bun test",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const entry = await waitForLog(sock, a.id, "terminal-command");
    expect(entry.terminal?.command).toBe("bun test");
  });

  it("terminal-command missing command -> 400; multiline -> 400 single-line", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    const missing = await affordance(srv, a.id, "terminal-command", {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("missing command");
    const multiline = await affordance(srv, a.id, "terminal-command", {
      command: "echo a\necho b",
    });
    expect(multiline.status).toBe(400);
    expect(multiline.body.error).toBe(
      "command must be single-line; join steps with && or ;",
    );
  });
});

describe("routes/affordances: diff (Phase 1.4b)", () => {
  it("unknown agent -> 404 agent not found", async () => {
    const srv = await startTestServer();
    server = srv;
    const r = await affordance(srv, "ghost", "diff", {});
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("agent not found");
  });

  it("non-repo cwd -> { ok:true } + kind:system 'not a git repository'", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    // The agent's cwd is the throwaway temp stateRoot, which is not a git repo,
    // so the diff machinery deterministically returns the not_repo branch.
    const a = await spawnAgent(srv, "Worker", room.id);
    const sock = await srv.connectWs(owner.rawSessionId);
    const r = await affordance(srv, a.id, "diff", {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const entry = await waitForLog(
      sock,
      a.id,
      "system",
      "not a git repository",
    );
    expect(entry.content).toContain("not a git repository");
  });
});

describe("routes/affordances: upload + file-serving (Phase 1.4b)", () => {
  it("upload to an unknown agent -> 404 agent not found", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const fd = new FormData();
    fd.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
    const res = await srv.http(`/api/upload/ghost`, {
      method: "POST",
      body: fd,
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("agent not found");
  });

  it("more than 5 files -> 400 Maximum 5 files per upload", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    const fd = new FormData();
    for (let i = 0; i < 6; i++) {
      fd.append("file", new File(["x"], `f${i}.txt`, { type: "text/plain" }));
    }
    const res = await srv.http(`/api/upload/${a.id}`, {
      method: "POST",
      body: fd,
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Maximum 5 files per upload");
  });

  it("small upload returns attachments, then GET /api/files serves the bytes; unknown filename -> 404", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    const fd = new FormData();
    fd.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const up = await srv.http(`/api/upload/${a.id}`, {
      method: "POST",
      body: fd,
      rawSessionId: owner.rawSessionId,
    });
    expect(up.status).toBe(200);
    const attachments = (await up.json()).attachments as Array<{
      filename: string;
      originalName: string;
      size: number;
    }>;
    expect(attachments.length).toBe(1);
    expect(attachments[0].originalName).toBe("note.txt");
    expect(attachments[0].size).toBe(5);
    // Serve it back (cookie-required: /api/files is not loopback-trusted).
    const got = await srv.http(
      `/api/files/${a.id}/${attachments[0].filename}`,
      {
        rawSessionId: owner.rawSessionId,
      },
    );
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("hello");
    // Frozen: served with a long-lived immutable cache header.
    expect(got.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    // The legacy /api/images/:id/:filename alias serves the same bytes (today's
    // file-serving handler resolves both prefixes through getFilePath).
    const legacy = await srv.http(
      `/api/images/${a.id}/${attachments[0].filename}`,
      { rawSessionId: owner.rawSessionId },
    );
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe("hello");
    const miss = await srv.http(`/api/files/${a.id}/missing.txt`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(miss.status).toBe(404);
  });
});
