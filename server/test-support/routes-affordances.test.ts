// Agent self-affordance (removal) + upload + file-serving route characterization.
//
// The legacy loopback agent self-affordances (POST /agents/:id/{read-file,diff,
// edit-file,terminal-command}) were REMOVED in the loopback-bypass removal
// milestone; agents use the token-required /api equivalents now (positive
// coverage in routes-agent-affordances-rest.test.ts). This file freezes that the
// deleted legacy surface fails CLOSED, plus the observable contract of the
// upload + file-serving routes that remain.
//
// The message route (POST /agents/:id/message) is deliberately EXCLUDED: its
// sender-authority + dedupe/cap/reject matrix is frozen by queue.test.ts.
//
// Key current behaviors frozen here:
//   - Legacy agent affordances are gone: a no-bearer loopback POST is rejected
//     401 at the cookie wall before any handler runs - fail-closed by
//     construction.
//   - /api/upload and /api/files require a cookie even from loopback (there is
//     no loopback bypass anywhere). Auth posture itself is frozen in routes-auth;
//     here we use a seeded owner cookie.
//   - Upload limits are 5 files / 200MB each / 400MB total in code today. We
//     freeze the cheap COUNT limit; the byte limits are intentionally NOT
//     exercised (allocating >200MB would bloat `bun test`).
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import type { AgentInfo } from "../../shared/types.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

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

interface HttpResult {
  status: number;
  body: { ok?: boolean; error?: string; [k: string]: unknown };
}

// Legacy agent affordances POST to /agents/:id/:action over loopback with NO
// bearer. There is no loopback bypass, so these requests are rejected 401 at the
// cookie wall (used below to prove the legacy surface fails closed). The
// token-required /api affordances are covered in
// routes-agent-affordances-rest.test.ts.
async function affordance(
  srv: TestServer,
  agentId: string,
  action: string,
  body: unknown,
  bearer?: string,
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const res = await srv.http(`/agents/${agentId}/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as HttpResult["body"],
  };
}

describe("routes/affordances: legacy loopback agent affordances removed (loopback-bypass removal)", () => {
  // The legacy loopback agent self-affordances (POST /agents/:id/{read-file,
  // edit-file,terminal-command,diff}) were deleted, and there is no loopback
  // bypass, so a no-bearer loopback POST is rejected 401 at the cookie
  // wall BEFORE any handler runs - which is exactly why the legacy surface now
  // fails closed (no handler, so no transcript write is possible). A VALID
  // bearer clears the cookie wall but hits the /agents/ POST block's JSON-404
  // fallback (not the SPA 200 HTML fall-through that would mask stale callers).
  // Positive coverage of the token-required /api replacements lives in
  // routes-agent-affordances-rest.test.ts.
  const cases: { action: string; body: Record<string, unknown> }[] = [
    { action: "read-file", body: { path: "hello.txt" } },
    { action: "edit-file", body: { path: "hello.txt" } },
    { action: "terminal-command", body: { command: "bun test" } },
    { action: "diff", body: {} },
  ];
  for (const { action, body } of cases) {
    it(`no-bearer legacy POST /agents/:id/${action} -> 401 (fail closed)`, async () => {
      const srv = await startTestServer();
      server = srv;
      await srv.seedOwner("Boss");
      const room = srv.agentManager.getRooms()[0];
      const a = await spawnAgent(srv, "Worker", room.id);
      const r = await affordance(srv, a.id, action, body);
      expect(r.status).toBe(401);
    });
  }

  it("a valid AGENT bearer to a deleted affordance path -> 404 (no side effect)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(a.id)!;
    const sock = await srv.connectWs(owner.rawSessionId);
    // A valid bearer clears the cookie wall, but the deleted affordance sub-block
    // is gone; the /agents/ POST block's JSON-404 fallback rejects it instead of
    // the SPA 200 HTML fall-through that would mask stale callers.
    const r = await affordance(
      srv,
      a.id,
      "read-file",
      { path: "hello.txt" },
      token,
    );
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not found");
    // Fail-closed: the deleted handler never ran, so no file-view card emitted.
    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    const fileViews = sock.messages.filter((m) => {
      const msg = m as {
        type?: string;
        entry?: { agentId?: string; kind?: string };
      };
      return (
        msg.type === "log_entry" &&
        msg.entry?.agentId === a.id &&
        msg.entry?.kind === "file-view"
      );
    });
    expect(fileViews.length).toBe(0);
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
    // Serve it back (cookie-required, like every other path).
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
