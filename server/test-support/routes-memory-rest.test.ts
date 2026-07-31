// isomux-memory on the unified REST surface - three verbs: READ (GET), APPEND
// (POST), REPLACE (PUT) /api/memory.
//
// All scopes (agent/room/office/boss) are permissive on EVERY verb: any
// authenticated caller may read/append/replace any EXISTING target - no access
// gate (Nil's product decision; restraint lives in the system-prompt affordance,
// recovery in the op-log). On APPEND author + date are server-stamped (never
// body). APPEND has an exact-duplicate guard. REPLACE is whole-file, guarded by
// the optimistic version from the preceding READ (409 on mismatch); it writes raw
// text verbatim. Evidence = the persisted memory/*.md files + the op-log + REST
// envelopes. Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, existsSync } from "fs";
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
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
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
function errVersion(body: unknown): string | undefined {
  return (body as { error?: { version?: string } }).error?.version;
}
function matchedText(body: unknown): string | undefined {
  return (body as { error?: { matched?: { text?: string } } }).error?.matched
    ?.text;
}
function readMem(srv: TestServer, ...parts: string[]): string | null {
  try {
    return readFileSync(join(srv.stateRoot, "memory", ...parts), "utf8");
  } catch {
    return null;
  }
}
function asRead(body: unknown): { text: string; version: string } {
  return body as { text: string; version: string };
}
function asAppend(body: unknown): { item: MemoryItem; version: string } {
  return body as { item: MemoryItem; version: string };
}

describe("routes/memory REST: identity required", () => {
  it("loopback no-cookie READ/APPEND/REPLACE -> 401 unauthenticated", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");

    for (const r of [
      await api(srv, "/api/memory?scope=agent"),
      await api(srv, "/api/memory", {
        method: "POST",
        body: { scope: "agent", text: "x" },
      }),
      await api(srv, "/api/memory", {
        method: "PUT",
        body: { scope: "agent", text: "x", version: "abc" },
      }),
    ]) {
      expect(r.status).toBe(401);
      expect(errCode(r.body)).toBe("unauthenticated");
    }
  });
});

describe("routes/memory REST: APPEND (agent own scope)", () => {
  it("appends a server-stamped raw line; body author/date ignored; returns item+version", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);

    expect(readMem(srv, "agents", `${bot.id}.md`)).toBeNull();

    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: {
        scope: "agent",
        text: "no em dashes in prose",
        author: "EVIL", // spoof attempts must be ignored
        date: "1999-12-31",
      },
    });
    expect(r.status).toBe(201);
    const { item, version } = asAppend(r.body);
    expect(item.author).toBe("MemBot");
    expect(item.text).toBe("no em dashes in prose");
    expect(item.scopeId).toBe(bot.id);
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item.date).not.toBe("1999-12-31");
    expect(item.raw).toBe(`- MemBot, ${item.date}: no em dashes in prose`);
    expect(version).toMatch(/^[0-9a-f]{12}$/);

    const onDisk = readMem(srv, "agents", `${bot.id}.md`)!;
    expect(onDisk).toBe(`- MemBot, ${item.date}: no em dashes in prose\n`);
    expect(onDisk).not.toContain("EVIL");
  });

  it("scopeId omitted defaults to the caller's own agent", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "pairs with Reviewer3" },
    });
    expect(r.status).toBe(201);
    expect(asAppend(r.body).item.scopeId).toBe(bot.id);
  });

  it("rejects missing/multiline/blank text", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    for (const text of [undefined, "a\nb", "   "]) {
      const r = await api(srv, "/api/memory", {
        method: "POST",
        bearer: token,
        body: { scope: "agent", text },
      });
      expect(r.status).toBe(400);
      expect(errCode(r.body)).toBe("invalid_text");
    }
  });
});

describe("routes/memory REST: APPEND dedup guard", () => {
  it("rejects an exact restatement 409 (matched text); first write 201; reword allowed", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);

    const first = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "Deploys at 9." },
    });
    expect(first.status).toBe(201);

    const dup = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "  deploys at 9  " },
    });
    expect(dup.status).toBe(409);
    expect(errCode(dup.body)).toBe("duplicate_memory");
    expect(matchedText(dup.body)).toBe("Deploys at 9.");

    const reword = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "deploys at 09:00 daily" },
    });
    expect(reword.status).toBe(201);
  });
});

describe("routes/memory REST: APPEND permissive + existence gates", () => {
  it("an agent may append to ANOTHER agent's scope (explicit id); nonexistent -> 404; malformed -> 400", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const a = await spawnAgent(srv, "A");
    const b = await spawnAgent(srv, "B");
    const tokenA = mintAgentToken(a.id, ownerId);

    const cross = await api(srv, "/api/memory", {
      method: "POST",
      bearer: tokenA,
      body: { scope: "agent", scopeId: b.id, text: "B fact from A" },
    });
    expect(cross.status).toBe(201);
    expect(readMem(srv, "agents", `${b.id}.md`)).toContain("B fact from A");

    const ghost = await api(srv, "/api/memory", {
      method: "POST",
      bearer: tokenA,
      body: { scope: "agent", scopeId: "nope", text: "x" },
    });
    expect(ghost.status).toBe(404);
    expect(errCode(ghost.body)).toBe("agent_not_found");

    const bad = await api(srv, "/api/memory", {
      method: "POST",
      bearer: tokenA,
      body: { scope: "agent", scopeId: "../etc", text: "x" },
    });
    expect(bad.status).toBe(400);
    expect(errCode(bad.body)).toBe("invalid_scope_id");
  });

  it("a USER cookie on agent scope must pass an explicit id (omitted -> 400)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const bot = await spawnAgent(srv, "MemBot");

    const omitted = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "agent", text: "x" },
    });
    expect(omitted.status).toBe(400);
    expect(errCode(omitted.body)).toBe("invalid_scope_id");

    const explicit = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "agent", scopeId: bot.id, text: "from the boss" },
    });
    expect(explicit.status).toBe(201);
    expect(asAppend(explicit.body).item.author).toBe("Boss");
  });
});

describe("routes/memory REST: READ", () => {
  it("returns {text, version}; empty before any write; reflects appends", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);

    const empty = await api(srv, "/api/memory?scope=agent", { bearer: token });
    expect(empty.status).toBe(200);
    expect(asRead(empty.body).text).toBe("");
    expect(asRead(empty.body).version).toMatch(/^[0-9a-f]{12}$/);

    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "uses Bun" },
    });
    const after = await api(srv, "/api/memory?scope=agent", { bearer: token });
    expect(asRead(after.body).text).toContain("uses Bun");
    expect(asRead(after.body).version).not.toBe(asRead(empty.body).version);
  });
});

describe("routes/memory REST: REPLACE (whole-file, version-guarded)", () => {
  async function seedAgent() {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "original" },
    });
    return { srv, bot, token };
  }

  it("overwrites verbatim with the version from READ; returns the new version", async () => {
    const { srv, bot, token } = await seedAgent();
    const { version } = asRead(
      (await api(srv, "/api/memory?scope=agent", { bearer: token })).body,
    );
    const rep = await api(srv, "/api/memory", {
      method: "PUT",
      bearer: token,
      body: {
        scope: "agent",
        text: "- edited line one\n- line two\n",
        version,
      },
    });
    expect(rep.status).toBe(200);
    expect((rep.body as { version: string }).version).toMatch(/^[0-9a-f]{12}$/);
    expect(readMem(srv, "agents", `${bot.id}.md`)).toBe(
      "- edited line one\n- line two\n",
    );
  });

  it("a stale version -> 409 memory_conflict with the current version; nothing written", async () => {
    const { srv, bot, token } = await seedAgent();
    const before = readMem(srv, "agents", `${bot.id}.md`);
    const rep = await api(srv, "/api/memory", {
      method: "PUT",
      bearer: token,
      body: { scope: "agent", text: "clobber", version: "deadbeef0000" },
    });
    expect(rep.status).toBe(409);
    expect(errCode(rep.body)).toBe("memory_conflict");
    expect(errVersion(rep.body)).toMatch(/^[0-9a-f]{12}$/);
    expect(readMem(srv, "agents", `${bot.id}.md`)).toBe(before);
  });

  it("a missing version -> 400 invalid_version", async () => {
    const { srv, token } = await seedAgent();
    const rep = await api(srv, "/api/memory", {
      method: "PUT",
      bearer: token,
      body: { scope: "agent", text: "x" },
    });
    expect(rep.status).toBe(400);
    expect(errCode(rep.body)).toBe("invalid_version");
  });

  it("ANY authenticated agent can REPLACE office memory (permissive, Nil's decision)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId); // a plain agent, NOT the owner

    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "office", text: "office one" },
    });
    const { version } = asRead(
      (await api(srv, "/api/memory?scope=office", { bearer: token })).body,
    );
    const rep = await api(srv, "/api/memory", {
      method: "PUT",
      bearer: token,
      body: {
        scope: "office",
        // free-text provenance survives verbatim on a rewrite (display only)
        text: "- Somebody Else, 2020-01-01: totally rewritten by an agent\n",
        version,
      },
    });
    expect(rep.status).toBe(200);
    expect(readMem(srv, "office.md")).toBe(
      "- Somebody Else, 2020-01-01: totally rewritten by an agent\n",
    );
  });
});

describe("routes/memory REST: boss scope", () => {
  it("agent omitted -> manager boss; user omitted -> own; explicit other boss is permissive; GET open to any caller", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Member");
    const ownerId = getUserByName("Boss")!.id;
    const memberId = getUserByName("Member")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId); // manager boss = Boss

    // agent omitted -> manager boss file (ownerId)
    const a = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "boss", text: "boss likes linear history" },
    });
    expect(a.status).toBe(201);
    expect(readMem(srv, "bosses", `${ownerId}.md`)).toContain(
      "boss likes linear history",
    );

    // member (user cookie) omitted -> own boss file
    const m = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { scope: "boss", text: "member fact" },
    });
    expect(m.status).toBe(201);
    expect(readMem(srv, "bosses", `${memberId}.md`)).toContain("member fact");

    // agent explicitly targets ANOTHER boss (member) -> permitted
    const cross = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "boss", scopeId: memberId, text: "about the member" },
    });
    expect(cross.status).toBe(201);

    // GET another boss's file works for any authenticated caller (intentional)
    const read = await api(srv, `/api/memory?scope=boss&scopeId=${memberId}`, {
      bearer: token,
    });
    expect(read.status).toBe(200);
    expect(asRead(read.body).text).toContain("member fact");
    void owner;
  });

  it("agent with null manager + omitted boss -> 400, and NO bosses/null.md", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const bot = await spawnAgent(srv, "Orphan");
    const orphan = mintAgentToken(bot.id, null); // no manager userId

    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: orphan,
      body: { scope: "boss", text: "x" },
    });
    expect(r.status).toBe(400);
    expect(errCode(r.body)).toBe("invalid_scope_id");
    expect(existsSync(join(srv.stateRoot, "memory", "bosses", "null.md"))).toBe(
      false,
    );
  });
});

describe("routes/memory REST: room/office scope resolution", () => {
  it("room requires an existing scopeId; office takes none", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    const roomId = srv.agentManager.getRooms()[0].id;

    const ok = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "room", scopeId: roomId, text: "room convention" },
    });
    expect(ok.status).toBe(201);

    const ghost = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "room", scopeId: "no-such-room", text: "x" },
    });
    expect(ghost.status).toBe(404);
    expect(errCode(ghost.body)).toBe("room_not_found");

    const officeWithId = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "office", scopeId: "x", text: "y" },
    });
    expect(officeWithId.status).toBe(400);
    expect(errCode(officeWithId.body)).toBe("invalid_scope_id");
  });
});

describe("routes/memory REST: op-log", () => {
  it("records a server-stamped entry per append and replace", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);

    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "one" },
    });
    const { version } = asRead(
      (await api(srv, "/api/memory?scope=agent", { bearer: token })).body,
    );
    await api(srv, "/api/memory", {
      method: "PUT",
      bearer: token,
      body: { scope: "agent", text: "- two\n", version },
    });

    const log = readFileSync(
      join(srv.stateRoot, "memory", ".oplog.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      actor: "MemBot",
      op: "append",
      text: "one",
    });
    expect(log[1]).toMatchObject({ actor: "MemBot", op: "replace" });
    expect(log[1].previousVersion).toBeDefined();
  });
});
