// isomux-memory on the unified REST surface (opIds memory.{list,create}).
//
// Scopes: agent (own file; 3a), room + office (3b). Identity-required (401 wall),
// author/date/id server-stamped (never body). room/office are authenticated +
// EXISTENCE-gated only (no room-access gate, permissive per Nil); office takes no
// scopeId; boss + cross-agent agent writes return DELIBERATE errors so the
// temporary posture can't be mistaken for the final permissive model. Evidence =
// the persisted memory/*.md files + REST envelopes.
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
function readMem(srv: TestServer, ...parts: string[]): string | null {
  try {
    return readFileSync(join(srv.stateRoot, "memory", ...parts), "utf8");
  } catch {
    return null;
  }
}
function memFile(srv: TestServer, agentId: string): string | null {
  return readMem(srv, "agents", `${agentId}.md`);
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

describe("routes/memory REST: cross-agent + rejections (permissive model)", () => {
  async function botCtx() {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    return { srv, bot, token: mintAgentToken(bot.id, ownerId), ownerId };
  }

  it("explicit other-agent scopeId -> 201, writes that agent's file (permissive)", async () => {
    const { srv, token } = await botCtx();
    const other = await spawnAgent(srv, "OtherBot");
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "agent",
        scopeId: other.id,
        factType: "preference",
        text: "note about OtherBot",
      },
    });
    expect(r.status).toBe(201);
    const item = r.body as MemoryItem;
    expect(item.scopeId).toBe(other.id);
    expect(item.author).toBe("MemBot"); // author is the WRITER, not the target
    expect(memFile(srv, other.id)).toContain("note about OtherBot");
  });

  it("explicit nonexistent agent scopeId -> 404 agent_not_found", async () => {
    const { srv, token } = await botCtx();
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "agent",
        scopeId: "agent-nope",
        factType: "preference",
        text: "x",
      },
    });
    expect(r.status).toBe(404);
    expect(errCode(r.body)).toBe("agent_not_found");
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

  it("unknown scope -> 400 unsupported_scope", async () => {
    const { srv, token } = await botCtx();
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "galaxy", factType: "rule", text: "x" },
    });
    expect(r.status).toBe(400);
    expect(errCode(r.body)).toBe("unsupported_scope");
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

  it("USER cookie on scope:agent: omitted -> 400 invalid_scope_id; explicit existing agent -> 201", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const bot = await spawnAgent(srv, "MemBot");

    // A user has no "own" agent, so an omitted scopeId is a 400 (not a 403/500).
    const omitted = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "agent", factType: "preference", text: "x" },
    });
    expect(omitted.status).toBe(400);
    expect(errCode(omitted.body)).toBe("invalid_scope_id");

    // But a user MAY target an explicit existing agent (permissive model).
    const explicit = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        scope: "agent",
        scopeId: bot.id,
        factType: "role",
        text: "from the boss",
      },
    });
    expect(explicit.status).toBe(201);
    expect((explicit.body as MemoryItem).author).toBe("Boss");
    expect(memFile(srv, bot.id)).toContain("from the boss");
  });
});

describe("routes/memory REST: room + office scopes (permissive, existence-gated)", () => {
  async function ctx() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const roomId = srv.agentManager.getRooms()[0].id;
    return {
      srv,
      owner,
      bot,
      roomId,
      token: mintAgentToken(bot.id, ownerId),
    };
  }

  it("agent writes a room fact -> rooms/<roomId>.md, author = agent name", async () => {
    const { srv, token, roomId } = await ctx();
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "room",
        scopeId: roomId,
        factType: "convention",
        text: "this room uses Bun",
      },
    });
    expect(r.status).toBe(201);
    const item = r.body as MemoryItem;
    expect(item.scope).toBe("room");
    expect(item.scopeId).toBe(roomId);
    expect(item.author).toBe("MemBot");
    expect(readMem(srv, "rooms", `${roomId}.md`)).toContain(
      "this room uses Bun",
    );
  });

  it("USER cookie writes room/office -> author = user name, body author/date/id ignored", async () => {
    const { srv, owner, roomId } = await ctx();
    const room = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        scope: "room",
        scopeId: roomId,
        factType: "rule",
        text: "no force pushes",
        author: "EVIL",
        date: "1999-12-31",
        id: "ffffff",
      },
    });
    expect(room.status).toBe(201);
    expect((room.body as MemoryItem).author).toBe("Boss");
    const onDiskRoom = readMem(srv, "rooms", `${roomId}.md`);
    expect(onDiskRoom).toContain("[Boss, ");
    expect(onDiskRoom).not.toContain("EVIL");
    expect(onDiskRoom).not.toContain("1999-12-31");

    const office = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        scope: "office",
        factType: "environment",
        text: "auntie is the box",
      },
    });
    expect(office.status).toBe(201);
    expect((office.body as MemoryItem).scopeId).toBeNull();
    expect(readMem(srv, "office.md")).toContain("auntie is the box");
  });

  it("GET room/office works for agent token and user cookie", async () => {
    const { srv, owner, token, roomId } = await ctx();
    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "room",
        scopeId: roomId,
        factType: "convention",
        text: "rf",
      },
    });
    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "office", factType: "environment", text: "of" },
    });
    for (const auth of [
      { bearer: token },
      { rawSessionId: owner.rawSessionId },
    ]) {
      const room = await api(
        srv,
        `/api/memory?scope=room&scopeId=${roomId}`,
        auth,
      );
      expect(room.status).toBe(200);
      expect((room.body as MemoryItem[])[0].text).toBe("rf");
      const office = await api(srv, "/api/memory?scope=office", auth);
      expect(office.status).toBe(200);
      expect((office.body as MemoryItem[])[0].text).toBe("of");
    }
  });

  it("room scope: missing/malformed scopeId -> 400 invalid_scope_id; nonexistent -> 404 room_not_found", async () => {
    const { srv, token } = await ctx();
    const missing = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "room", factType: "rule", text: "x" },
    });
    expect(missing.status).toBe(400);
    expect(errCode(missing.body)).toBe("invalid_scope_id");

    const malformed = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "room", scopeId: "../x", factType: "rule", text: "x" },
    });
    expect(malformed.status).toBe(400);
    expect(errCode(malformed.body)).toBe("invalid_scope_id");

    const ghost = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "room",
        scopeId: "room-nope",
        factType: "rule",
        text: "x",
      },
    });
    expect(ghost.status).toBe(404);
    expect(errCode(ghost.body)).toBe("room_not_found");

    // Same rules on GET.
    const getMissing = await api(srv, "/api/memory?scope=room", {
      bearer: token,
    });
    expect(getMissing.status).toBe(400);
    expect(errCode(getMissing.body)).toBe("invalid_scope_id");
    const getGhost = await api(
      srv,
      "/api/memory?scope=room&scopeId=room-nope",
      {
        bearer: token,
      },
    );
    expect(getGhost.status).toBe(404);
    expect(errCode(getGhost.body)).toBe("room_not_found");
  });

  it("office with a provided scopeId -> 400 invalid_scope_id (POST and GET)", async () => {
    const { srv, token, roomId } = await ctx();
    const post = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "office",
        scopeId: roomId,
        factType: "environment",
        text: "x",
      },
    });
    expect(post.status).toBe(400);
    expect(errCode(post.body)).toBe("invalid_scope_id");

    const get = await api(srv, `/api/memory?scope=office&scopeId=${roomId}`, {
      bearer: token,
    });
    expect(get.status).toBe(400);
    expect(errCode(get.body)).toBe("invalid_scope_id");
  });
});

describe("routes/memory REST: boss scope (permissive; auto-load is the only boss boundary)", () => {
  async function ctx() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    await srv.seedMember("Member");
    const ownerId = getUserByName("Boss")!.id;
    const memberId = getUserByName("Member")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId); // manager boss = Boss
    return { srv, owner, ownerId, memberId, bot, token };
  }

  it("agent omitted scopeId -> manager boss file; author = agent name", async () => {
    const { srv, token, ownerId } = await ctx();
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "boss",
        factType: "preference",
        text: "boss likes terse replies",
      },
    });
    expect(r.status).toBe(201);
    const item = r.body as MemoryItem;
    expect(item.scope).toBe("boss");
    expect(item.scopeId).toBe(ownerId);
    expect(item.author).toBe("MemBot");
    expect(readMem(srv, "bosses", `${ownerId}.md`)).toContain(
      "boss likes terse replies",
    );
  });

  it("user omitted scopeId -> own boss file; body author/date/id ignored", async () => {
    const { srv, owner, ownerId } = await ctx();
    const r = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        scope: "boss",
        factType: "preference",
        text: "no em dashes",
        author: "EVIL",
        date: "1999-12-31",
        id: "ffffff",
      },
    });
    expect(r.status).toBe(201);
    expect((r.body as MemoryItem).scopeId).toBe(ownerId);
    const onDisk = readMem(srv, "bosses", `${ownerId}.md`);
    expect(onDisk).toContain("[Boss, ");
    expect(onDisk).not.toContain("EVIL");
    expect(onDisk).not.toContain("1999-12-31");
  });

  it("explicit other-boss scopeId -> writes that boss's file (any caller, permissive)", async () => {
    const { srv, token, memberId } = await ctx();
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "boss",
        scopeId: memberId,
        factType: "contact",
        text: "about the other boss",
      },
    });
    expect(r.status).toBe(201);
    expect((r.body as MemoryItem).scopeId).toBe(memberId);
    expect(readMem(srv, "bosses", `${memberId}.md`)).toContain(
      "about the other boss",
    );
  });

  it("agent w/ null manager userId: omitted boss -> 400 and NO bosses/null.md; explicit valid boss -> 201", async () => {
    const { srv, bot, ownerId } = await ctx();
    const orphanToken = mintAgentToken(bot.id, null); // no manager userId
    const omitted = await api(srv, "/api/memory", {
      method: "POST",
      bearer: orphanToken,
      body: { scope: "boss", factType: "rule", text: "x" },
    });
    expect(omitted.status).toBe(400);
    expect(errCode(omitted.body)).toBe("invalid_scope_id");
    expect(readMem(srv, "bosses", "null.md")).toBeNull();

    const explicit = await api(srv, "/api/memory", {
      method: "POST",
      bearer: orphanToken,
      body: { scope: "boss", scopeId: ownerId, factType: "rule", text: "ok" },
    });
    expect(explicit.status).toBe(201);
  });

  it("nonexistent boss -> 404 user_not_found; malformed -> 400 invalid_scope_id", async () => {
    const { srv, token } = await ctx();
    const ghost = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "boss",
        scopeId: "user-nope",
        factType: "rule",
        text: "x",
      },
    });
    expect(ghost.status).toBe(404);
    expect(errCode(ghost.body)).toBe("user_not_found");

    const malformed = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "boss", scopeId: "../x", factType: "rule", text: "x" },
    });
    expect(malformed.status).toBe(400);
    expect(errCode(malformed.body)).toBe("invalid_scope_id");
  });

  it("GET another boss's file works for any authenticated caller (intentional exposure)", async () => {
    const { srv, owner, token, memberId } = await ctx();
    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "boss",
        scopeId: memberId,
        factType: "contact",
        text: "member fact",
      },
    });
    const byAgent = await api(
      srv,
      `/api/memory?scope=boss&scopeId=${memberId}`,
      { bearer: token },
    );
    expect(byAgent.status).toBe(200);
    expect((byAgent.body as MemoryItem[])[0].text).toBe("member fact");

    const byUser = await api(
      srv,
      `/api/memory?scope=boss&scopeId=${memberId}`,
      { rawSessionId: owner.rawSessionId },
    );
    expect(byUser.status).toBe(200);
    expect((byUser.body as MemoryItem[])[0].text).toBe("member fact");
  });

  it("GET ?scope=boss omitted scopeId resolves the caller's own/manager boss", async () => {
    const { srv, owner, token } = await ctx();
    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "boss", factType: "preference", text: "manager default" },
    });
    // Agent (manager = Boss) GET omitted -> Boss's file.
    const byAgent = await api(srv, "/api/memory?scope=boss", { bearer: token });
    expect(byAgent.status).toBe(200);
    expect((byAgent.body as MemoryItem[])[0].text).toBe("manager default");
    // User (Boss) GET omitted -> own file (same target).
    const byUser = await api(srv, "/api/memory?scope=boss", {
      rawSessionId: owner.rawSessionId,
    });
    expect(byUser.status).toBe(200);
    expect(
      (byUser.body as MemoryItem[]).some((m) => m.text === "manager default"),
    ).toBe(true);
  });
});

describe("routes/memory REST: edit + retract (PATCH/DELETE, slice 3d)", () => {
  async function ctx() {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    const roomId = srv.agentManager.getRooms()[0].id;
    return { srv, token, roomId };
  }
  async function createRoomFact(
    srv: TestServer,
    token: string,
    roomId: string,
    text: string,
  ): Promise<string> {
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "room", scopeId: roomId, factType: "convention", text },
    });
    return (r.body as MemoryItem).id;
  }

  it("PATCH supersedes: GET shows new text not old; raw retains both", async () => {
    const { srv, token, roomId } = await ctx();
    const id = await createRoomFact(srv, token, roomId, "old text");
    const r = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "room", scopeId: roomId, text: "new text" },
    });
    expect(r.status).toBe(200);
    const item = r.body as MemoryItem;
    expect(item.text).toBe("new text");
    expect(item.supersedes).toBe(id);
    expect(item.author).toBe("MemBot");

    const list = await api(srv, `/api/memory?scope=room&scopeId=${roomId}`, {
      bearer: token,
    });
    const texts = (list.body as MemoryItem[]).map((m) => m.text);
    expect(texts).toContain("new text");
    expect(texts).not.toContain("old text");

    const raw = readMem(srv, "rooms", `${roomId}.md`)!;
    expect(raw).toContain("old text");
    expect(raw).toContain("new text");
  });

  it("DELETE tombstones: GET shows neither; raw retains the tombstone", async () => {
    const { srv, token, roomId } = await ctx();
    const id = await createRoomFact(srv, token, roomId, "to be retracted");
    const del = await api(
      srv,
      `/api/memory/${id}?scope=room&scopeId=${roomId}`,
      { method: "DELETE", bearer: token },
    );
    expect(del.status).toBe(204);

    const list = await api(srv, `/api/memory?scope=room&scopeId=${roomId}`, {
      bearer: token,
    });
    expect(list.body).toEqual([]);

    const raw = readMem(srv, "rooms", `${roomId}.md`)!;
    expect(raw).toContain(`tombstones:${id}`);
    expect(raw).toContain("(retracted)");
  });

  it("PATCH/DELETE require an explicit target (no own/manager default)", async () => {
    const { srv, token, roomId } = await ctx();
    const id = await createRoomFact(srv, token, roomId, "x");
    const noScopeId = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "agent", text: "y" },
    });
    expect(noScopeId.status).toBe(400);
    expect(errCode(noScopeId.body)).toBe("invalid_scope_id");

    const officeWithId = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "office", scopeId: roomId, text: "y" },
    });
    expect(officeWithId.status).toBe(400);
    expect(errCode(officeWithId.body)).toBe("invalid_scope_id");

    const delNoScope = await api(srv, `/api/memory/${id}?scope=agent`, {
      method: "DELETE",
      bearer: token,
    });
    expect(delNoScope.status).toBe(400);
    expect(errCode(delNoScope.body)).toBe("invalid_scope_id");
  });

  it("malformed :id -> 400 invalid_id; unknown/already-superseded -> 404 memory_not_found", async () => {
    const { srv, token, roomId } = await ctx();
    const malformed = await api(srv, `/api/memory/ZZZ`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "room", scopeId: roomId, text: "y" },
    });
    expect(malformed.status).toBe(400);
    expect(errCode(malformed.body)).toBe("invalid_id");

    const unknown = await api(srv, `/api/memory/ffffff`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "room", scopeId: roomId, text: "y" },
    });
    expect(unknown.status).toBe(404);
    expect(errCode(unknown.body)).toBe("memory_not_found");

    const id = await createRoomFact(srv, token, roomId, "v1");
    await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "room", scopeId: roomId, text: "v2" },
    });
    const again = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "room", scopeId: roomId, text: "v3" },
    });
    expect(again.status).toBe(404);
    expect(errCode(again.body)).toBe("memory_not_found");
  });

  it("PATCH/DELETE require identity (401 wall)", async () => {
    const { srv, token, roomId } = await ctx();
    const id = await createRoomFact(srv, token, roomId, "x");
    const patch = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      body: { scope: "room", scopeId: roomId, text: "y" },
    });
    expect(patch.status).toBe(401);
    const del = await api(
      srv,
      `/api/memory/${id}?scope=room&scopeId=${roomId}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(401);
  });

  it("Idempotency-Key: a retried PATCH appends only one supersede line", async () => {
    const { srv, token, roomId } = await ctx();
    const id = await createRoomFact(srv, token, roomId, "v1");
    const headers = { "Idempotency-Key": "patch-1" };
    const a = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      headers,
      body: { scope: "room", scopeId: roomId, text: "v2" },
    });
    const b = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      headers,
      body: { scope: "room", scopeId: roomId, text: "v2" },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as MemoryItem).id).toBe((b.body as MemoryItem).id);
    const raw = readMem(srv, "rooms", `${roomId}.md`)!;
    const supLines = raw.split("\n").filter((l) => l.includes("supersedes:"));
    expect(supLines).toHaveLength(1);
  });

  it("office PATCH/DELETE work with scope=office and no scopeId", async () => {
    const { srv, token } = await ctx();
    const post = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "office", factType: "environment", text: "office v1" },
    });
    const id = (post.body as MemoryItem).id;
    const patch = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "office", text: "office v2" },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as MemoryItem).text).toBe("office v2");
    const newId = (patch.body as MemoryItem).id;
    const del = await api(srv, `/api/memory/${newId}?scope=office`, {
      method: "DELETE",
      bearer: token,
    });
    expect(del.status).toBe(204);
    const list = await api(srv, "/api/memory?scope=office", { bearer: token });
    expect(list.body).toEqual([]);
  });

  it("DELETE an already-tombstoned id -> 404 memory_not_found", async () => {
    const { srv, token, roomId } = await ctx();
    const id = await createRoomFact(srv, token, roomId, "x");
    const first = await api(
      srv,
      `/api/memory/${id}?scope=room&scopeId=${roomId}`,
      { method: "DELETE", bearer: token },
    );
    expect(first.status).toBe(204);
    const second = await api(
      srv,
      `/api/memory/${id}?scope=room&scopeId=${roomId}`,
      { method: "DELETE", bearer: token },
    );
    expect(second.status).toBe(404);
    expect(errCode(second.body)).toBe("memory_not_found");
  });

  it("PATCH ignores body author/date/id/supersedes; server-stamps the supersede line", async () => {
    const { srv, token, roomId } = await ctx();
    const id = await createRoomFact(srv, token, roomId, "orig");
    const r = await api(srv, `/api/memory/${id}`, {
      method: "PATCH",
      bearer: token,
      body: {
        scope: "room",
        scopeId: roomId,
        text: "updated",
        author: "EVIL",
        date: "1999-12-31",
        id: "ffffff",
        supersedes: "aaaaaa",
      },
    });
    expect(r.status).toBe(200);
    const item = r.body as MemoryItem;
    expect(item.author).toBe("MemBot");
    expect(item.id).not.toBe("ffffff");
    expect(item.id).toMatch(/^[0-9a-f]{6}$/);
    expect(item.date).not.toBe("1999-12-31");
    // The relation comes from the path :id, never the body's supersedes.
    expect(item.supersedes).toBe(id);
    const raw = readMem(srv, "rooms", `${roomId}.md`)!;
    expect(raw).not.toContain("EVIL");
    expect(raw).not.toContain("1999-12-31");
    expect(raw).toContain(`supersedes:${id}`);
  });
});

describe("routes/memory REST: dedup guard (slice 3e)", () => {
  async function ctx() {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    const roomId = srv.agentManager.getRooms()[0].id;
    return { srv, token, roomId };
  }
  function post(srv: TestServer, token: string, body: unknown) {
    return api(srv, "/api/memory", { method: "POST", bearer: token, body });
  }
  function matched(body: unknown): { id?: string; text?: string } | undefined {
    return (body as { error?: { matched?: { id?: string; text?: string } } })
      .error?.matched;
  }

  it("a restatement is rejected 409 with the matched id; first write is 201", async () => {
    const { srv, token, roomId } = await ctx();
    const first = await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "this room uses Bun",
    });
    expect(first.status).toBe(201);
    const firstId = (first.body as MemoryItem).id;

    const dup = await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "This room uses Bun!",
    });
    expect(dup.status).toBe(409);
    expect(errCode(dup.body)).toBe("duplicate_memory");
    expect(matched(dup.body)?.id).toBe(firstId);

    const reorder = await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "uses Bun this room",
    });
    expect(reorder.status).toBe(409);
    expect(matched(reorder.body)?.id).toBe(firstId);
  });

  it("a distinct fact and the same text in another scope are not duplicates", async () => {
    const { srv, token, roomId } = await ctx();
    await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "this room uses Bun",
    });
    const distinct = await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "this room uses Deno",
    });
    expect(distinct.status).toBe(201);
    const office = await post(srv, token, {
      scope: "office",
      factType: "environment",
      text: "this room uses Bun",
    });
    expect(office.status).toBe(201); // different scope/file
  });

  it("PATCH supersede is exempt from the dedup guard", async () => {
    const { srv, token, roomId } = await ctx();
    await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "fact A",
    });
    const b = await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "fact B",
    });
    const bId = (b.body as MemoryItem).id;
    // Supersede B with text identical to A's -> allowed (PATCH is exempt).
    const patch = await api(srv, `/api/memory/${bId}`, {
      method: "PATCH",
      bearer: token,
      body: { scope: "room", scopeId: roomId, text: "fact A" },
    });
    expect(patch.status).toBe(200);
  });

  it("the 409 detail names the match but leaks no filesystem path", async () => {
    const { srv, token, roomId } = await ctx();
    await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "secret-ish fact",
    });
    const dup = await post(srv, token, {
      scope: "room",
      scopeId: roomId,
      factType: "convention",
      text: "secret-ish fact",
    });
    expect(dup.status).toBe(409);
    expect(matched(dup.body)?.text).toBe("secret-ish fact");
    const serialized = JSON.stringify(dup.body);
    expect(serialized).not.toContain("memory/rooms");
    expect(serialized).not.toContain(srv.stateRoot);
  });
});
