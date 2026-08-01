// GET /api/agents/:id/logs on the unified REST surface (opId agents.logs) -
// conversation-log search and retrieval (tasks da7b2899 + b6d07978).
//
// The core semantics are covered in log-search.test.ts against fixtures. What
// THIS file freezes is the route: the three modes over real HTTP, and above all
// the AUTHORIZATION MATRIX, because this route is the one place a new
// capability (`log:read`) widened what an ordinary agent token can reach.
//
// The scope Nil chose supersedes an earlier self-only design: an agent may read
// the logs of any agent in a room its BOSS can access. So the matrix has to
// pin both halves - that a room-mate IS reachable (the widening actually works)
// and that an agent in a room the boss cannot access is NOT (the widening
// stops where room access stops). A test that only checked the second half
// would pass just as well on a self-only implementation.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { _testResetSearchAdmission } from "../log-search-runner.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// `bun test` shares one process across files, and search admission counters are
// process-global by design - a scan that hits its deadline holds its slot until
// its child process is observed to exit. Without this, the deliberately wedged
// scans in log-search-isolation.test.ts could starve the searches below with a
// 429 they never asked for, making this file's result depend on file ordering.
// (Reset is epoch-bumping, so a child still exiting from a previous generation
// cannot decrement the counters this file then relies on.)
beforeEach(_testResetSearchAdmission);

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  srv: TestServer,
  path: string,
  init: { rawSessionId?: string; bearer?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    headers,
    rawSessionId: init.rawSessionId,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

const errCode = (r: Res): unknown =>
  (r.body as { error?: { code?: string } }).error?.code;

async function spawnOwnedBy(
  srv: TestServer,
  name: string,
  roomId: string,
  desk: number,
  username: string,
): Promise<AgentInfo> {
  const user = getUserByName(username);
  if (!user) throw new Error(`unknown user: ${username}`);
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    desk,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    username,
    "claude",
    undefined,
    user.id,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

// Write a small conversation onto disk for `agentId`. The route reads the real
// log tree under STATE_ROOT, so this is the same path production uses.
function seedLog(srv: TestServer, agentId: string, sessionId = "s-seed"): void {
  const dir = join(srv.stateRoot, "logs", agentId);
  mkdirSync(dir, { recursive: true });
  const entries: LogEntry[] = [
    {
      id: "p1",
      agentId,
      kind: "user_message",
      content: "please look at the marmalade problem",
      timestamp: 1_000,
    },
    {
      id: "a1",
      agentId,
      kind: "text",
      content: "I looked at it and the marmalade is fine",
      timestamp: 2_000,
    },
    {
      id: "t1",
      agentId,
      kind: "thinking",
      content: "secretly the marmalade worries me",
      timestamp: 3_000,
    },
    {
      id: "x1",
      agentId,
      kind: "tool_call",
      content: "Bash",
      timestamp: 4_000,
    },
  ];
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "sessions.json"),
    JSON.stringify({
      [sessionId]: { topic: "The marmalade problem", lastModified: 4_000 },
    }),
  );
}

describe("routes/logs REST: the three modes", () => {
  it("no query lists the agent's sessions", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    seedLog(srv, agent.id);

    const r = await api(srv, `/api/agents/${agent.id}/logs`, {
      bearer: mintAgentToken(agent.id, getUserByName(owner.username)!.id),
    });
    expect(r.status).toBe(200);
    expect(r.body.sessions).toEqual([
      {
        sessionId: "s-seed",
        topic: "The marmalade problem",
        lastModified: 4_000,
      },
    ]);
  });

  it("?q= searches and returns a context handle for each hit", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    seedLog(srv, agent.id);
    const bearer = mintAgentToken(agent.id, getUserByName(owner.username)!.id);

    const r = await api(srv, `/api/agents/${agent.id}/logs?q=marmalade`, {
      bearer,
    });
    expect(r.status).toBe(200);
    // Default tier: the prompt and the reply, NOT the thinking trace.
    const hits = r.body.results as { entryId: string; sessionId: string }[];
    expect(hits.map((h) => h.entryId)).toEqual(["a1", "p1"]);
    expect(r.body.totalMatches).toBe(2);
    expect(r.body.truncated).toBe(false);
    expect(r.body.timedOut).toBe(false);
    // The response states the selection it actually applied, so a caller never
    // has to re-derive it from the parameters they sent.
    expect(r.body.tier).toBe("conversation");
    expect(r.body.kinds).toEqual(["user_message", "text"]);

    // The handle round-trips: feed {sessionId, entryId} straight back.
    const ctx = await api(
      srv,
      `/api/agents/${agent.id}/logs?session=${hits[0].sessionId}&around=${hits[0].entryId}&window=1`,
      { bearer },
    );
    expect(ctx.status).toBe(200);
    expect(ctx.body.found).toBe(true);
    expect(
      (ctx.body.entries as { entryId: string }[]).map((e) => e.entryId),
    ).toEqual(["p1", "a1"]);
  });

  it("?session= retrieves the conversation, with thinking gated behind the tier", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    seedLog(srv, agent.id);
    const bearer = mintAgentToken(agent.id, getUserByName(owner.username)!.id);

    const ids = async (qs: string): Promise<string[]> => {
      const r = await api(
        srv,
        `/api/agents/${agent.id}/logs?session=s-seed${qs}`,
        {
          bearer,
        },
      );
      expect(r.status).toBe(200);
      return (r.body.entries as { entryId: string }[]).map((e) => e.entryId);
    };

    expect(await ids("&tier=prompts")).toEqual(["p1"]);
    expect(await ids("")).toEqual(["p1", "a1"]); // conversation is the default
    expect(await ids("&tier=full")).toEqual(["p1", "a1", "t1", "x1"]);
  });

  it("rejects a bad query with a 400 and a specific code", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    const bearer = mintAgentToken(agent.id, getUserByName(owner.username)!.id);

    expect(
      errCode(
        await api(srv, `/api/agents/${agent.id}/logs?tier=nope`, { bearer }),
      ),
    ).toBe("invalid_tier");
    expect(
      errCode(
        await api(srv, `/api/agents/${agent.id}/logs?q=x&limit=999`, {
          bearer,
        }),
      ),
    ).toBe("invalid_limit");
    expect(
      errCode(
        await api(srv, `/api/agents/${agent.id}/logs?q=%5B&regex=1`, {
          bearer,
        }),
      ),
    ).toBe("invalid_regex");
  });

  it("an unknown session is a 404, and a traversal attempt never reaches the filesystem", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    seedLog(srv, agent.id);
    const bearer = mintAgentToken(agent.id, getUserByName(owner.username)!.id);

    const missing = await api(
      srv,
      `/api/agents/${agent.id}/logs?session=nope`,
      {
        bearer,
      },
    );
    expect(missing.status).toBe(404);
    expect(errCode(missing)).toBe("unknown_session");

    // Rejected by shape before it is ever compared against the session list,
    // so no `..` segment is available to build a path from.
    const traversal = await api(
      srv,
      `/api/agents/${agent.id}/logs?session=${encodeURIComponent("../../../etc/passwd")}`,
      { bearer },
    );
    expect(traversal.status).toBe(400);
    expect(errCode(traversal)).toBe("unknown_session");
  });
});

describe("routes/logs REST: authorization matrix", () => {
  it("an agent reads its OWN logs", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    seedLog(srv, agent.id);

    const r = await api(srv, `/api/agents/${agent.id}/logs`, {
      bearer: mintAgentToken(agent.id, getUserByName(owner.username)!.id),
    });
    expect(r.status).toBe(200);
  });

  it("an agent reads a ROOM-MATE's logs - the widening past self-only actually works", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const alpha = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    const beta = await spawnOwnedBy(srv, "Beta", roomA, 1, owner.username);
    seedLog(srv, beta.id);

    const r = await api(srv, `/api/agents/${beta.id}/logs?q=marmalade`, {
      bearer: mintAgentToken(alpha.id, getUserByName(owner.username)!.id),
    });
    expect(r.status).toBe(200);
    expect(r.body.totalMatches).toBe(2);
  });

  it("an agent reads an agent in ANOTHER room its boss can access", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    const alpha = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    const gamma = await spawnOwnedBy(srv, "Gamma", roomB, 0, owner.username);
    seedLog(srv, gamma.id);

    // The owner reaches every room by rule, so its agent does too.
    const r = await api(srv, `/api/agents/${gamma.id}/logs`, {
      bearer: mintAgentToken(alpha.id, getUserByName(owner.username)!.id),
    });
    expect(r.status).toBe(200);
  });

  it("an agent CANNOT read an agent in a room its boss cannot access", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    // Mia is granted roomB only.
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });

    const mias = await spawnOwnedBy(
      srv,
      "MiasAgent",
      roomB,
      0,
      member.username,
    );
    const bosses = await spawnOwnedBy(
      srv,
      "BossAgent",
      roomA,
      0,
      owner.username,
    );
    seedLog(srv, bosses.id);

    const r = await api(srv, `/api/agents/${bosses.id}/logs?q=marmalade`, {
      bearer: mintAgentToken(mias.id, getUserByName("Mia")!.id),
    });
    expect(r.status).toBe(403);
    expect(errCode(r)).toBe("forbidden");
  });

  it("a human reads an agent in a room they can access, and is refused elsewhere", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });

    const inA = await spawnOwnedBy(srv, "InA", roomA, 0, owner.username);
    const inB = await spawnOwnedBy(srv, "InB", roomB, 0, owner.username);
    seedLog(srv, inA.id);
    seedLog(srv, inB.id);

    expect(
      (
        await api(srv, `/api/agents/${inB.id}/logs`, {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(srv, `/api/agents/${inA.id}/logs`, {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
    // The owner reaches both by rule.
    expect(
      (
        await api(srv, `/api/agents/${inA.id}/logs`, {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(200);
  });

  it("an agent keeps its OWN history when its boss loses access to the room", async () => {
    // The self branch is checked FIRST and independently of room access, so an
    // agent can never be locked out of its own past by a grant change it had no
    // part in. Only its reach into OTHER agents follows its boss.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });

    const mine = await spawnOwnedBy(srv, "Mine", roomB, 0, member.username);
    const peer = await spawnOwnedBy(srv, "Peer", roomB, 1, member.username);
    seedLog(srv, mine.id);
    seedLog(srv, peer.id);
    const bearer = mintAgentToken(mine.id, getUserByName("Mia")!.id);

    // Both reachable while the grant stands.
    expect(
      (await api(srv, `/api/agents/${mine.id}/logs`, { bearer })).status,
    ).toBe(200);
    expect(
      (await api(srv, `/api/agents/${peer.id}/logs`, { bearer })).status,
    ).toBe(200);

    // Mia loses roomB. The agent still reads itself; the peer is now closed.
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [] });
    expect(
      (await api(srv, `/api/agents/${mine.id}/logs`, { bearer })).status,
    ).toBe(200);
    expect(
      (await api(srv, `/api/agents/${peer.id}/logs`, { bearer })).status,
    ).toBe(403);

    // The owner is unaffected either way (reaches every room by rule).
    expect(
      (
        await api(srv, `/api/agents/${peer.id}/logs`, {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(200);
  });

  it("a CRON-RUN token is refused - a run has no history and holds no log:read", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    seedLog(srv, agent.id);

    const runToken = mintRunToken(
      "job-1",
      "run-1",
      getUserByName(owner.username)!.id,
    );
    const r = await api(srv, `/api/agents/${agent.id}/logs`, {
      bearer: runToken,
    });
    expect(r.status).toBe(403);
  });

  it("an unknown agent denies exactly like an inaccessible one (non-leak)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const alpha = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);
    const bearer = mintAgentToken(alpha.id, getUserByName(owner.username)!.id);

    const unknown = await api(srv, `/api/agents/agent-does-not-exist/logs`, {
      bearer,
    });
    expect(unknown.status).toBe(403);
    expect(errCode(unknown)).toBe("forbidden");
  });

  it("no identity at all is a 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", roomA, 0, owner.username);

    const r = await api(srv, `/api/agents/${agent.id}/logs`);
    expect(r.status).toBe(401);
    expect(errCode(r)).toBe("unauthenticated");
  });
});
