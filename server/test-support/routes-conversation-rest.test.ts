// Phase 3d slice 6a — conversation REST contract.
//
// HTTP-contract layer for the conversation cluster cut over from the WS command
// bus (send/edit/cancel/sendNow/newConversation/resume/listSessions). Pins status
// codes + ack shapes for the cores wired in server/routes/handlers/conversation.ts.
//
// COMPLEMENTS, not duplicates:
//   - queue.test.ts deeply covers sendMessage's queue mechanics + the AGENT
//     (inter-agent) sender-authority + dedupe/cap/error-state status codes.
//   - projection.test.ts covers the listSessions + send-message room ACL (403).
// This file pins the USER branch happy paths, the 204 mutations, and the
// 400/422 malformed-body boundaries that those files don't exercise directly.
//
// Seam: startTestServer() — real auth + the /api executor. The default FakeBackend
// auto-completes, so a USER send returns its immediate ack without a hung turn.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import type { SessionInfo } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

async function req(
  srv: TestServer,
  method: string,
  path: string,
  init: { body?: unknown; rawSessionId?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
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

async function spawnAt(srv: TestServer, name: string, roomId: string) {
  // spawn(name, cwd, permissionMode, desk, customInstructions, roomId, ...).
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

describe("agents.sendMessage REST — USER branch (Phase 3d slice 6a)", () => {
  it("owner send -> 200 with an empty MessageAck (the turn streams over WS)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "POST", `/api/agents/${x.id}/messages`, {
      rawSessionId: owner.rawSessionId,
      body: { text: "hello" },
    });
    expect(res.status).toBe(200);
    // The USER ack carries no queued id — the message echoes/streams over WS.
    expect((res.body as { messageId?: string }).messageId).toBe("");
  });

  it("no auth -> 401 (the /api wall rejects before the handler)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "POST", `/api/agents/${x.id}/messages`, {
      body: { text: "hello" },
    });
    expect(res.status).toBe(401);
  });

  it("missing text -> 400 invalid_text", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "POST", `/api/agents/${x.id}/messages`, {
      rawSessionId: owner.rawSessionId,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(errCode(res.body)).toBe("invalid_text");
  });

  it("malformed attachments (non-array) -> 422; the agent is untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    // {attachments:{}} is truthy but non-iterable — flushQueue would later spread
    // it and throw. The handler must reject at the boundary before any enqueue.
    const res = await req(srv, "POST", `/api/agents/${x.id}/messages`, {
      rawSessionId: owner.rawSessionId,
      body: { text: "x", attachments: {} },
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_request");
    // Nothing reached the backend / queue.
    expect(srv.fakeBackend.sessionForAgent(x.id)?.sent.length ?? 0).toBe(0);
  });

  it("non-string device -> 422 invalid_request", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "POST", `/api/agents/${x.id}/messages`, {
      rawSessionId: owner.rawSessionId,
      body: { text: "x", device: { not: "a string" } },
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_request");
  });
});

describe("agents.editMessage / resume REST (Phase 3d slice 6a)", () => {
  it("editMessage -> 200 empty ack (fire-and-forget; the corrected turn streams)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    // A bogus logEntryId is tolerated (the WS path was fire-and-forget too); the
    // contract is the ack shape, not the edit landing.
    const res = await req(
      srv,
      "PATCH",
      `/api/agents/${x.id}/messages/entry-1`,
      { rawSessionId: owner.rawSessionId, body: { newText: "fixed" } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { messageId?: string }).messageId).toBe("");
  });

  it("editMessage missing newText -> 422", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(
      srv,
      "PATCH",
      `/api/agents/${x.id}/messages/entry-1`,
      { rawSessionId: owner.rawSessionId, body: {} },
    );
    expect(res.status).toBe(422);
  });

  it("editMessage non-string device -> 422", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(
      srv,
      "PATCH",
      `/api/agents/${x.id}/messages/entry-1`,
      {
        rawSessionId: owner.rawSessionId,
        body: { newText: "fixed", device: 123 },
      },
    );
    expect(res.status).toBe(422);
  });

  it("resume -> 204", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "POST", `/api/agents/${x.id}/resume`, {
      rawSessionId: owner.rawSessionId,
      body: { sessionId: "some-session" },
    });
    expect(res.status).toBe(204);
  });

  it("resume missing sessionId -> 422", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "POST", `/api/agents/${x.id}/resume`, {
      rawSessionId: owner.rawSessionId,
      body: {},
    });
    expect(res.status).toBe(422);
  });
});

describe("agents cancelQueued / sendNow / newConversation REST -> 204 (Phase 3d slice 6a)", () => {
  it("cancelQueued -> 204 (no-op safe on an unknown messageId)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "DELETE", `/api/agents/${x.id}/queue/nope`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
  });

  it("sendNow -> 204", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "POST", `/api/agents/${x.id}/send-now`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
  });

  it("newConversation -> 204", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "POST", `/api/agents/${x.id}/new-conversation`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
  });
});

describe("agents.listSessions REST (Phase 3d slice 6a)", () => {
  it("owner GET -> 200 with { sessions, currentSessionId }", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1);
    const res = await req(srv, "GET", `/api/agents/${x.id}/sessions`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      sessions?: SessionInfo[];
      currentSessionId?: string | null;
    };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect("currentSessionId" in (res.body as object)).toBe(true);
  });
});
