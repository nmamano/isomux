// Phase 3a slice 3a.3a — agent self-affordances on the unified REST surface
// (opIds agents.readFile / diff / editFile / terminalCommand).
//
// The agent-scope analogue of the cron RUN-affordances: AGENT bearer
// (`self:affordance` + agentParamMustEqualTokenAgent), so an agent acts ONLY on
// its OWN chat. What this freezes:
//   - AGENT-bearer happy paths surface the file-view / edit-request /
//     terminal-command / diff card into the agent's chat as a normal `log_entry`.
//   - That log_entry rides the NORMAL room-ACL projection (routeAgentEvent), NOT
//     a raw broadcast: a member without access to the agent's room never sees it.
//   - The central idempotency layer applies to these side-effecting log emitters.
//   - Cross-agent / unknown `:id` is 403 (token binds the agent), a USER cookie is
//     403 (no self:affordance), and no identity is 401 (allowLoopback:false).
//   - The legacy loopback /agents/:id/* paths stay untouched (frozen elsewhere).
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
import { getAgentTokenRaw } from "../identity/tokens.ts";
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
  label = "cond",
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

interface Res {
  status: number;
  body: { ok?: boolean; error?: { code?: string }; [k: string]: unknown };
}
async function affordance(
  srv: TestServer,
  agentId: string,
  action: string,
  body: unknown,
  opts: {
    bearer?: string;
    rawSessionId?: string;
    idempotencyKey?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await srv.http(`/api/agents/${agentId}/${action}`, {
    method: "POST",
    headers,
    rawSessionId: opts.rawSessionId,
    body: JSON.stringify(body),
  });
  let parsed: Res["body"] = {};
  try {
    parsed = (await res.json()) as Res["body"];
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

function countLog(
  sock: TestSocket,
  agentId: string,
  kind: LogEntry["kind"],
  contains?: string,
): number {
  return sock.messages.filter((m) => {
    const msg = m as { type?: string; entry?: LogEntry };
    return (
      msg.type === "log_entry" &&
      msg.entry?.agentId === agentId &&
      msg.entry?.kind === kind &&
      (contains === undefined || msg.entry.content.includes(contains))
    );
  }).length;
}

describe("routes/agent-affordances REST: AGENT bearer happy paths + room-ACL projection", () => {
  it("read-file: 200 + a file-view log_entry that rides room-ACL — owner sees it, a no-access member does NOT", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mallory"); // fresh member: allowedRooms []
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id);
    if (!token) throw new Error("agent token not minted on spawn");
    writeFileSync(join(srv.stateRoot, "report.txt"), "hi there");

    const ownerSock = await srv.connectWs(owner.rawSessionId);
    const memberSock = await srv.connectWs(member.rawSessionId);

    const r = await affordance(
      srv,
      agent.id,
      "read-file",
      { path: "report.txt" },
      { bearer: token },
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // Owner (room access by owner-rule) receives the affordance log_entry...
    await waitUntil(
      () => countLog(ownerSock, agent.id, "file-view") >= 1,
      2000,
      "owner sees file-view",
    );
    // ...and the restricted member does NOT (proves room-ACL projection, not a
    // raw broadcast). ping/pong barrier: any broadcast would have been ws.send'd
    // before this ping, so pong implies it already arrived if it were going to.
    memberSock.send({ type: "ping" });
    await memberSock.waitFor("pong");
    expect(countLog(memberSock, agent.id, "file-view")).toBe(0);
  });

  it("edit-file existing -> 200 + edit-request log_entry", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    writeFileSync(join(srv.stateRoot, "edit-me.txt"), "content");
    const sock = await srv.connectWs(owner.rawSessionId);
    const r = await affordance(
      srv,
      agent.id,
      "edit-file",
      { path: "edit-me.txt" },
      { bearer: token },
    );
    expect(r.status).toBe(200);
    await waitUntil(
      () => countLog(sock, agent.id, "edit-request") >= 1,
      2000,
      "edit-request",
    );
  });

  it("terminal-command single-line -> 200 + terminal-command log_entry", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    const sock = await srv.connectWs(owner.rawSessionId);
    const r = await affordance(
      srv,
      agent.id,
      "terminal-command",
      { command: "bun test" },
      { bearer: token },
    );
    expect(r.status).toBe(200);
    await waitUntil(
      () => countLog(sock, agent.id, "terminal-command") >= 1,
      2000,
      "terminal-command",
    );
  });

  it("diff non-repo cwd -> 200 + system log_entry 'not a git repository'", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    // The agent cwd is the throwaway temp stateRoot, not a git repo.
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    const sock = await srv.connectWs(owner.rawSessionId);
    const r = await affordance(srv, agent.id, "diff", {}, { bearer: token });
    expect(r.status).toBe(200);
    await waitUntil(
      () => countLog(sock, agent.id, "system", "not a git repository") >= 1,
      2000,
      "diff non-repo system entry",
    );
  });
});

describe("routes/agent-affordances REST: validation + manager-error mapping", () => {
  it("read-file missing path -> 400", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    const r = await affordance(
      srv,
      agent.id,
      "read-file",
      {},
      { bearer: token },
    );
    expect(r.status).toBe(400);
  });

  it("terminal-command missing command -> 400; multiline -> 400 (mapped from the manager result)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    expect(
      (
        await affordance(
          srv,
          agent.id,
          "terminal-command",
          {},
          { bearer: token },
        )
      ).status,
    ).toBe(400);
    // Multiline is rejected by the MANAGER (single-line check); the handler maps
    // that 400 1:1 — proving it doesn't only catch the missing-command case.
    const multi = await affordance(
      srv,
      agent.id,
      "terminal-command",
      { command: "echo a\necho b" },
      { bearer: token },
    );
    expect(multi.status).toBe(400);
  });
});

describe("routes/agent-affordances REST: idempotency", () => {
  it("same Idempotency-Key replays read-file (200) but writes exactly one log_entry", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;
    writeFileSync(join(srv.stateRoot, "idem.txt"), "x");
    const sock = await srv.connectWs(owner.rawSessionId);

    const first = await affordance(
      srv,
      agent.id,
      "read-file",
      { path: "idem.txt" },
      { bearer: token, idempotencyKey: "k-1" },
    );
    expect(first.status).toBe(200);
    await waitUntil(
      () => countLog(sock, agent.id, "file-view") >= 1,
      2000,
      "first file-view",
    );

    const replay = await affordance(
      srv,
      agent.id,
      "read-file",
      { path: "idem.txt" },
      { bearer: token, idempotencyKey: "k-1" },
    );
    expect(replay.status).toBe(200);

    // ping/pong barrier: a non-replayed handler run would have ws.send'd a second
    // file-view during the replay POST, before this ping. Ordered delivery means
    // pong implies it already arrived. A replay must NOT re-run the handler.
    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    expect(countLog(sock, agent.id, "file-view")).toBe(1);
  });
});

describe("routes/agent-affordances REST: authz", () => {
  it("an agent token cannot affordance a DIFFERENT agent's chat -> 403", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "Alice", room.id);
    const b = await spawnAgent(srv, "Bob", room.id);
    const aToken = getAgentTokenRaw(a.id)!;
    const r = await affordance(
      srv,
      b.id,
      "read-file",
      { path: "x" },
      { bearer: aToken },
    );
    expect(r.status).toBe(403);
  });

  it("a USER cookie cannot reach an agent affordance (no self:affordance) -> 403", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const r = await affordance(
      srv,
      agent.id,
      "read-file",
      { path: "x" },
      { rawSessionId: owner.rawSessionId },
    );
    expect(r.status).toBe(403);
  });

  it("no identity (no cookie, no bearer) -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const r = await affordance(srv, agent.id, "read-file", { path: "x" });
    expect(r.status).toBe(401);
  });
});
