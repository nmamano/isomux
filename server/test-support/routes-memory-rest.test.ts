// isomux-memory on the unified REST surface — slice 3a (opIds memory.{list,create}).
//
// 3a is the agent-scope tracer: an agent reads/writes its OWN memory file.
// Identity-required (401 wall), author/date/id server-stamped (never body),
// scopeId is a target selector but an agent may only target itself, and every
// not-yet-supported path returns a DELIBERATE error so the temporary posture is
// pinned. Evidence = the persisted agents/<id>.md file + REST envelopes.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import type { AgentInfo, MemoryItem } from "../../shared/types.ts";

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
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function spawnAgent(srv: TestServer, name: string): Promise<AgentInfo> {
  const roomId = srv.agentManager.getRooms()[0].id;
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

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}
function memFile(srv: TestServer, agentId: string): string | null {
  try {
    return readFileSync(
      join(srv.stateRoot, "memory", "agents", `${agentId}.md`),
      "utf8",
    );
  } catch {
    return null;
  }
}

describe("routes/memory REST: identity required", () => {
  it("loopback no-cookie GET/POST /api/memory -> 401 unauthenticated", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");

    const g = await api(srv, "/api/memory?scope=agent");
    expect(g.status).toBe(401);
    expect(errCode(g.body)).toBe("unauthenticated");

    const p = await api(srv, "/api/memory", {
      method: "POST",
      body: { scope: "agent", factType: "preference", text: "x" },
    });
    expect(p.status).toBe(401);
    expect(errCode(p.body)).toBe("unauthenticated");
  });
});

describe("routes/memory REST: agent writes its own scope", () => {
  it("POST appends to agents/<id>.md, author server-stamped, body author/date/id ignored", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);

    expect(memFile(srv, bot.id)).toBeNull(); // nothing yet

    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      // Spoof attempt: author/date/id in the body MUST be ignored.
      body: {
        scope: "agent",
        factType: "preference",
        text: "no em dashes in prose",
        author: "EVIL",
        date: "1999-12-31",
        id: "ffffff",
      },
    });
    expect(r.status).toBe(201);
    const item = r.body as MemoryItem;
    expect(item.author).toBe("MemBot");
    expect(item.text).toBe("no em dashes in prose");
    expect(item.scope).toBe("agent");
    expect(item.scopeId).toBe(bot.id);
    expect(item.id).toMatch(/^[0-9a-f]{6}$/);
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item.date).not.toBe("1999-12-31");

    const onDisk = memFile(srv, bot.id);
    expect(onDisk).toContain("[MemBot, ");
    expect(onDisk).toContain("no em dashes in prose");
    expect(onDisk).not.toContain("EVIL");
    expect(onDisk).not.toContain("1999-12-31");
  });

  it("GET ?scope=agent returns the agent's lines (empty before any write)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);

    const empty = await api(srv, "/api/memory?scope=agent", { bearer: token });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", factType: "convention", text: "uses Bun" },
    });
    const list = await api(srv, "/api/memory?scope=agent", { bearer: token });
    expect(list.status).toBe(200);
    const items = list.body as MemoryItem[];
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("uses Bun");
    expect(items[0].author).toBe("MemBot");
  });

  it("scopeId omitted defaults to the caller's own agent id", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", factType: "role", text: "pairs with Reviewer3" },
    });
    expect(r.status).toBe(201);
    expect((r.body as MemoryItem).scopeId).toBe(bot.id);
  });
});

describe("routes/memory REST: deliberate rejections (temporary 3a posture)", () => {
  async function botCtx() {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    return { srv, bot, token: mintAgentToken(bot.id, ownerId), ownerId };
  }

  it("explicit other-agent scopeId -> 403 forbidden", async () => {
    const { srv, token } = await botCtx();
    const other = await spawnAgent(srv, "OtherBot");
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "agent",
        scopeId: other.id,
        factType: "preference",
        text: "x",
      },
    });
    expect(r.status).toBe(403);
    expect(errCode(r.body)).toBe("forbidden");
  });

  it("malformed scopeId (path traversal) -> 400 invalid_scope_id", async () => {
    const { srv, token } = await botCtx();
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "agent",
        scopeId: "../../etc/passwd",
        factType: "preference",
        text: "x",
      },
    });
    expect(r.status).toBe(400);
    expect(errCode(r.body)).toBe("invalid_scope_id");
  });

  it("non-agent scope (room/office/boss) -> 400 unsupported_scope", async () => {
    const { srv, token } = await botCtx();
    for (const scope of ["room", "office", "boss"]) {
      const r = await api(srv, "/api/memory", {
        method: "POST",
        bearer: token,
        body: { scope, scopeId: "room-1", factType: "rule", text: "x" },
      });
      expect(r.status).toBe(400);
      expect(errCode(r.body)).toBe("unsupported_scope");
    }
  });

  it("invalid factType -> 400 invalid_fact_type", async () => {
    const { srv, token } = await botCtx();
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", factType: "bogus", text: "x" },
    });
    expect(r.status).toBe(400);
    expect(errCode(r.body)).toBe("invalid_fact_type");
  });

  it("blank-after-trim text -> 400 invalid_text", async () => {
    const { srv, token } = await botCtx();
    const blank = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", factType: "preference", text: "   " },
    });
    expect(blank.status).toBe(400);
    expect(errCode(blank.body)).toBe("invalid_text");
  });

  it("newlines in text -> 400 invalid_text (embedded, trailing, and CR)", async () => {
    const { srv, bot, token } = await botCtx();
    // A trailing "\n"/"\r" must be rejected on the RAW body, not silently
    // trimmed into a valid line — the one-fact-per-line rail.
    for (const text of ["line one\nline two", "trailing\n", "carriage\r"]) {
      const r = await api(srv, "/api/memory", {
        method: "POST",
        bearer: token,
        body: { scope: "agent", factType: "preference", text },
      });
      expect(r.status).toBe(400);
      expect(errCode(r.body)).toBe("invalid_text");
    }
    // Nothing was persisted by any of those rejected writes.
    expect(memFile(srv, bot.id)).toBeNull();
  });

  it("USER cookie on scope:agent (POST and GET) -> 400 unsupported_caller", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const post = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "agent", factType: "preference", text: "x" },
    });
    expect(post.status).toBe(400);
    expect(errCode(post.body)).toBe("unsupported_caller");

    const get = await api(srv, "/api/memory?scope=agent", {
      rawSessionId: owner.rawSessionId,
    });
    expect(get.status).toBe(400);
    expect(errCode(get.body)).toBe("unsupported_caller");
  });

  it("GET non-agent scope -> 400 unsupported_scope", async () => {
    const { srv, token } = await botCtx();
    for (const scope of ["room", "office", "boss"]) {
      const r = await api(srv, `/api/memory?scope=${scope}`, { bearer: token });
      expect(r.status).toBe(400);
      expect(errCode(r.body)).toBe("unsupported_scope");
    }
  });
});
