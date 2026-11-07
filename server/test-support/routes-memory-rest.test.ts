import { officeAuditStore } from "../audit-store.ts";
// isomux-memory on the unified REST surface - three verbs: READ (GET), APPEND
// (POST), REPLACE (PUT) /api/memory.
//
// Access follows the rooms (task bf94d714): room memory to whoever reaches the
// room; a member's memory read by whoever shares a live ordinary room with that
// member and written by the member's own identities; an agent's memory written
// by the agent, its manager's identities and owners, and read also by whoever
// reaches its room; office memory by any caller. Owners reach everything. No
// read is a 404 like a missing target; a read without a write is 403
// memory_write_forbidden. On APPEND author + date are server-stamped (never
// body). APPEND has an exact-duplicate guard. REPLACE is whole-file, guarded by
// the optimistic version from the preceding READ (409 on mismatch); it writes raw
// text verbatim. Evidence = the persisted memory/*.md files + the op-log + REST
// envelopes. Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import type { AgentInfo, MemoryItem } from "../../shared/types.ts";
import { MEMORY_LINE_MAX } from "../memory-store.ts";

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

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}
function errMessage(body: unknown): string | undefined {
  return (body as { error?: { message?: string } }).error?.message;
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
function opLog(_srv: TestServer) {
  return officeAuditStore()
    .list()
    .items.filter((row) => row.operation.startsWith("memory."))
    .reverse();
}
function asRead(body: unknown): {
  text: string;
  version: string;
  size: number;
  cap: number;
} {
  return body as { text: string; version: string; size: number; cap: number };
}
function asAppend(body: unknown): {
  item: MemoryItem;
  version: string;
  size: number;
  cap: number;
} {
  return body as {
    item: MemoryItem;
    version: string;
    size: number;
    cap: number;
  };
}

describe("routes/memory REST: APPEND (agent own scope)", () => {
  // Task f9d2bbac: a note an agent writes to its OWN agent scope is stamped with
  // the date only. The author there would name the reader, and it costs twice -
  // against the scope's hard cap and again in that agent's own prompt. Every
  // other writer stays named; the two cases below pin that.
  it("self-note: date-only raw line, body author/date ignored; returns item+version", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
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
    const { item, version, size, cap } = asAppend(r.body);
    expect(item.author).toBeNull();
    expect(item.text).toBe("no em dashes in prose");
    expect(item.scopeId).toBe(bot.id);
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item.date).not.toBe("1999-12-31");
    expect(item.raw).toBe(`- ${item.date}: no em dashes in prose`);
    expect(item.raw).not.toContain("MemBot");
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(size).toBe(item.raw.length);
    expect(cap).toBe(5000);

    const onDisk = readMem(srv, "agents", `${bot.id}.md`)!;
    expect(onDisk).toBe(`- ${item.date}: no em dashes in prose\n`);
    expect(onDisk).not.toContain("EVIL");
    // The op-log actor is unaffected - it must always name someone, and it is
    // the authoritative who-did-what.
    expect(opLog(srv).at(-1)!.actor.name).toBe("MemBot");
  });

  it("ANOTHER agent writing to this agent's scope stays named", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const other = await spawnAgent(srv, "Nosy");
    // Privileged: it edits MemBot's instructions, so it writes its memory.
    const token = mintAgentToken(other.id, ownerId, true);

    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", scopeId: bot.id, text: "MemBot owns the parser" },
    });
    expect(r.status).toBe(201);
    const { item } = asAppend(r.body);
    expect(item.author).toBe("Nosy");
    expect(item.raw).toBe(`- Nosy, ${item.date}: MemBot owns the parser`);
  });

  it("an agent's note to ANOTHER scope (room) stays named", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    const roomId = srv.agentManager.getRooms()[0].id;

    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "room", scopeId: roomId, text: "the build needs bun" },
    });
    expect(r.status).toBe(201);
    const { item } = asAppend(r.body);
    expect(item.author).toBe("MemBot");
    expect(item.raw).toBe(`- MemBot, ${item.date}: the build needs bun`);
  });

  // The author-less line stays a first-class line: the normalized-duplicate
  // guard parses it (409, not a silent second copy).
  it("a self-note still participates in the duplicate guard", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    const body = { scope: "agent", text: "prefer a named constant" };

    const first = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body,
    });
    expect(first.status).toBe(201);
    const dup = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body,
    });
    expect(dup.status).toBe(409);
    expect(errCode(dup.body)).toBe("duplicate_memory");
    expect(matchedText(dup.body)).toBe("prefer a named constant");
  });

  it("rejects missing/multiline/blank text", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
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

  it("rejects a line over 400 characters, naming its length", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);
    const size = MEMORY_LINE_MAX + 1;
    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "x".repeat(size) },
    });
    expect(r.status).toBe(422);
    expect(errCode(r.body)).toBe("memory_line_too_long");
    // The message names the measured length.
    expect(errMessage(r.body)).toContain(String(size));
    expect(readMem(srv, "agents", `${bot.id}.md`)).toBeNull();
  });
});

describe("routes/memory REST: APPEND dedup guard", () => {
  it("rejects an exact restatement 409 (matched text); first write 201; reword allowed", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
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

describe("routes/memory REST: APPEND hard cap", () => {
  it("a line that would put the scope over its cap -> 422 memory_over_cap, nothing written", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const bot = await spawnAgent(srv, "CapBot");
    const token = mintAgentToken(bot.id, ownerId);

    const huge = "x".repeat(400);
    for (let i = 0; i < 12; i++) {
      const seeded = await api(srv, "/api/memory", {
        method: "POST",
        bearer: token,
        body: { scope: "agent", text: `${i}:${huge.slice(3)}` },
      });
      expect(seeded.status).toBe(201);
    }
    const res = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: `overflow:${huge.slice(9)}` },
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("memory_over_cap");

    const read = await api(srv, "/api/memory?scope=agent", { bearer: token });
    expect((read.body as { text: string }).text).not.toContain("overflow:");
  });
});

describe("routes/memory REST: APPEND existence gates", () => {
  it("a privileged agent appends to another agent's scope (explicit id); nonexistent -> 404; malformed -> 400", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const a = await spawnAgent(srv, "A");
    const b = await spawnAgent(srv, "B");
    const tokenA = mintAgentToken(a.id, ownerId, true);

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
    const owner = await srv.seedOwner("Morgan");
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
      body: { scope: "agent", scopeId: bot.id, text: "from the morgan" },
    });
    expect(explicit.status).toBe(201);
    const { item } = asAppend(explicit.body);
    expect(item.author).toBe("Morgan");
    expect(item.raw).toBe(`- Morgan, ${item.date}: from the morgan`);
  });
});

describe("routes/memory REST: READ", () => {
  it("returns text, version, the prompt-injected size, and the scope cap", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);

    const empty = await api(srv, "/api/memory?scope=agent", { bearer: token });
    expect(empty.status).toBe(200);
    expect(asRead(empty.body).text).toBe("");
    expect(asRead(empty.body).version).toMatch(/^[0-9a-f]{12}$/);
    expect(asRead(empty.body).size).toBe(0);
    expect(asRead(empty.body).cap).toBe(5000);

    await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "agent", text: "uses Bun" },
    });
    const after = await api(srv, "/api/memory?scope=agent", { bearer: token });
    expect(asRead(after.body).text).toContain("uses Bun");
    expect(asRead(after.body).version).not.toBe(asRead(empty.body).version);
    expect(asRead(after.body).size).toBe(asRead(after.body).text.trim().length);

    // The size is the prompt-injected one: blank lines do not count.
    await api(srv, "/api/memory", {
      method: "PUT",
      bearer: token,
      body: {
        scope: "agent",
        text: "one\n   \ntwo\n",
        version: asRead(after.body).version,
      },
    });
    const read = asRead(
      (await api(srv, "/api/memory?scope=agent", { bearer: token })).body,
    );
    expect(read.size).toBe("one\ntwo".length);
  });
});

describe("routes/memory REST: REPLACE (whole-file, version-guarded)", () => {
  async function seedAgent() {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
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

  it("a stale version -> 409 memory_conflict with the current version, a missing one -> 400; nothing written", async () => {
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

    const missing = await api(srv, "/api/memory", {
      method: "PUT",
      bearer: token,
      body: { scope: "agent", text: "x" },
    });
    expect(missing.status).toBe(400);
    expect(errCode(missing.body)).toBe("invalid_version");
    expect(readMem(srv, "agents", `${bot.id}.md`)).toBe(before);
  });

  it("ANY authenticated agent can REPLACE office memory (permissive, Nil's decision)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
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

describe("routes/memory REST: member scope", () => {
  it("agent omitted -> its manager; user omitted -> own; an owner's agent reaches another member", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Member");
    const ownerId = getUserByName("Morgan")!.id;
    const memberId = getUserByName("Member")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId); // manager = Morgan

    // agent omitted -> its manager's file (ownerId)
    const a = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "member", text: "manager likes linear history" },
    });
    expect(a.status).toBe(201);
    expect(readMem(srv, "bosses", `${ownerId}.md`)).toContain(
      "manager likes linear history",
    );

    // member (user cookie) omitted -> own member file
    const m = await api(srv, "/api/memory", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { scope: "member", text: "member fact" },
    });
    expect(m.status).toBe(201);
    expect(readMem(srv, "bosses", `${memberId}.md`)).toContain("member fact");

    // the owner's agent explicitly targets ANOTHER member -> owner reach
    const cross = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "member", scopeId: memberId, text: "about the member" },
    });
    expect(cross.status).toBe(201);

    // and reads it
    const read = await api(
      srv,
      `/api/memory?scope=member&scopeId=${memberId}`,
      {
        bearer: token,
      },
    );
    expect(read.status).toBe(200);
    expect(asRead(read.body).text).toContain("member fact");
    void owner;
  });

  it("agent with null manager + omitted member scopeId -> 400, and NO bosses/null.md", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const bot = await spawnAgent(srv, "Orphan");
    const orphan = mintAgentToken(bot.id, null); // no manager userId

    const r = await api(srv, "/api/memory", {
      method: "POST",
      bearer: orphan,
      body: { scope: "member", text: "x" },
    });
    expect(r.status).toBe(400);
    expect(errCode(r.body)).toBe("invalid_scope_id");
    expect(existsSync(join(srv.stateRoot, "memory", "bosses", "null.md"))).toBe(
      false,
    );
  });
});

// Task f41c93e9 renamed the scope `boss` to `member`, and `boss` stayed an alias
// for one release (removed in task 744fa64a). Audit rows and transcripts
// written before the rename still carry it, so the audit filter reads both.
describe("routes/memory REST: the old boss name of member scope", () => {
  it("scope=boss is refused like any unknown scope on read, append and replace, and writes nothing", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const bot = await spawnAgent(srv, "MemBot");
    const token = mintAgentToken(bot.id, ownerId);

    const seeded = await api(srv, "/api/memory", {
      method: "POST",
      bearer: token,
      body: { scope: "member", text: "kept fact" },
    });
    expect(seeded.status).toBe(201);
    const before = readMem(srv, "bosses", `${ownerId}.md`);
    const { version } = asRead(
      (await api(srv, "/api/memory?scope=member", { bearer: token })).body,
    );
    const audited = opLog(srv).length;

    for (const [label, send] of [
      ["read", () => api(srv, "/api/memory?scope=boss", { bearer: token })],
      [
        "append",
        () =>
          api(srv, "/api/memory", {
            method: "POST",
            bearer: token,
            body: { scope: "boss", text: "through the old name" },
          }),
      ],
      [
        "replace",
        () =>
          api(srv, "/api/memory", {
            method: "PUT",
            bearer: token,
            body: { scope: "boss", text: "- replaced\n", version },
          }),
      ],
    ] as const) {
      const r = await send();
      expect([label, r.status, errCode(r.body)]).toEqual([
        label,
        400,
        "unsupported_scope",
      ]);
    }
    expect(readMem(srv, "bosses", `${ownerId}.md`)).toBe(before);
    expect(opLog(srv).length).toBe(audited);
  });

  it("an audit targetId filter on either name finds member-memory rows of both names", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Member");
    const ownerId = getUserByName("Morgan")!.id;
    const memberId = getUserByName("Member")!.id;
    // A row an older release wrote, before the rename.
    officeAuditStore().append({
      actor: { kind: "member", id: ownerId, name: "Morgan" },
      operation: "memory.replace",
      targets: [`memory:boss:${ownerId}`],
      fields: ["content"],
      memoryContent: "- legacy version\n",
    });
    for (const [scopeId, text] of [
      [ownerId, "current version"],
      [memberId, "another member's note"],
    ]) {
      const r = await api(srv, "/api/memory", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: { scope: "member", scopeId, text },
      });
      expect(r.status).toBe(201);
    }

    const history = async (targetId: string) => {
      const res = await api(
        srv,
        `/api/audit-log?targetId=${encodeURIComponent(targetId)}`,
        { rawSessionId: owner.rawSessionId },
      );
      expect(res.status).toBe(200);
      return (
        res.body as { items: { targets: string[]; memoryContent?: string }[] }
      ).items;
    };
    const byNew = await history(`memory:member:${ownerId}`);
    expect(byNew.map((row) => row.targets[0]).sort()).toEqual([
      `memory:boss:${ownerId}`,
      `memory:member:${ownerId}`,
    ]);
    expect(
      byNew.some((row) => row.memoryContent?.includes("legacy version")),
    ).toBe(true);
    expect(
      byNew.some((row) => row.memoryContent?.includes("current version")),
    ).toBe(true);
    expect(await history(`memory:boss:${ownerId}`)).toEqual(byNew);
  });
});

describe("routes/memory REST: room/office scope resolution", () => {
  it("room requires an existing scopeId; office takes none", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
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
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
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

    const log = opLog(srv);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      actor: { kind: "agent", id: bot.id, name: "MemBot" },
      operation: "memory.append",
    });
    expect(log[0].memoryContent).toContain("one");
    expect(log[1]).toMatchObject({
      actor: { kind: "agent", id: bot.id, name: "MemBot" },
      operation: "memory.replace",
      memoryContent: "- two\n",
    });
  });
});

// READ names the scope it resolved, so a reader can join a read to the block
// injected into its prompt: that block labels each scope by NAME, the API takes
// an ID. A valid id of the WRONG room must read as a different room.
describe("routes/memory REST: READ names the resolved scope", () => {
  function asNamed(body: unknown): {
    scopeId: string | null;
    name: string | null;
  } {
    return body as { scopeId: string | null; name: string | null };
  }
  // The label line directly above `note` in the prompt's memory block.
  function labelAbove(prompt: string, note: string): string {
    const lines = prompt.split("\n");
    const at = lines.findIndex((l) => l.includes(note));
    if (at < 1) throw new Error(`note not in prompt: ${note}`);
    return lines[at - 1];
  }

  it("a room or member read carries the name its injected block shows; another room's valid id reads as that other room", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const ownerId = getUserByName("Morgan")!.id;
    const alpha = srv.agentManager.createRoom("Alpha Lab");
    const beta = srv.agentManager.createRoom("Beta Lab");
    const bot = await srv.agentManager.spawn(
      "MemBot",
      srv.workDir,
      "default",
      undefined,
      undefined,
      alpha,
      undefined,
      undefined,
      undefined,
      "Morgan",
      "claude",
      undefined,
      ownerId,
    );
    if (!bot) throw new Error("spawn returned null");
    const token = mintAgentToken(bot.id, ownerId);
    for (const [scope, scopeId, text] of [
      ["room", alpha, "alpha room note"],
      ["room", beta, "beta room note"],
      ["member", ownerId, "member scope note"],
    ]) {
      const r = await api(srv, "/api/memory", {
        method: "POST",
        bearer: token,
        body: { scope, scopeId, text },
      });
      expect(r.status).toBe(201);
    }
    const promptRes = await api(srv, `/api/agents/${bot.id}/system-prompt`, {
      bearer: token,
    });
    expect(promptRes.status).toBe(200);
    const prompt = (promptRes.body as { prompt: string }).prompt;
    // Enabling condition: the agent's own room is injected, the other is not.
    expect(prompt).toContain("alpha room note");
    expect(prompt).not.toContain("beta room note");

    const own = await api(srv, `/api/memory?scope=room&scopeId=${alpha}`, {
      bearer: token,
    });
    const other = await api(srv, `/api/memory?scope=room&scopeId=${beta}`, {
      bearer: token,
    });
    expect(own.status).toBe(200);
    expect(other.status).toBe(200);
    expect(asNamed(own.body).scopeId).toBe(alpha);
    expect(asNamed(other.body).scopeId).toBe(beta);
    const ownName = asNamed(own.body).name;
    const otherName = asNamed(other.body).name;
    expect(typeof ownName).toBe("string");
    expect(typeof otherName).toBe("string");
    const roomLabel = labelAbove(prompt, "alpha room note");
    expect(roomLabel).toContain(`"${ownName}"`);
    expect(roomLabel).not.toContain(`"${otherName}"`);

    // Member scope, defaulted from the agent's manager.
    const managerRead = await api(srv, "/api/memory?scope=member", {
      bearer: token,
    });
    expect(managerRead.status).toBe(200);
    expect(asNamed(managerRead.body).scopeId).toBe(ownerId);
    const managerName = asNamed(managerRead.body).name;
    expect(typeof managerName).toBe("string");
    expect(labelAbove(prompt, "member scope note")).toContain(
      `"${managerName}"`,
    );

    // The name is read live: after a rename the read and the next prompt agree.
    expect(srv.agentManager.renameRoom(alpha, "Gamma Lab")).toBe(true);
    const renamed = await api(srv, `/api/memory?scope=room&scopeId=${alpha}`, {
      bearer: token,
    });
    const renamedName = asNamed(renamed.body).name;
    expect(renamedName).not.toBe(ownName);
    const nextPrompt = (
      (await api(srv, `/api/agents/${bot.id}/system-prompt`, { bearer: token }))
        .body as { prompt: string }
    ).prompt;
    expect(labelAbove(nextPrompt, "alpha room note")).toContain(
      `"${renamedName}"`,
    );
  });

  it("agent, member and office reads name their resolved target; unknown ids keep their 404 codes", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Member");
    const ownerId = getUserByName("Morgan")!.id;
    const memberId = getUserByName("Member")!.id;
    // Member shares a room with Morgan, so reads Morgan's member memory.
    const shared = srv.agentManager.createRoom("Shared");
    expect(updateUserById(memberId, { allowedRooms: [shared] }).ok).toBe(true);
    const bot = await spawnAgent(srv, "MemBot");
    const peer = await spawnAgent(srv, "PeerBot");
    const token = mintAgentToken(bot.id, ownerId);

    const self = await api(srv, "/api/memory?scope=agent", { bearer: token });
    expect(self.status).toBe(200);
    expect(asNamed(self.body)).toMatchObject({
      scopeId: bot.id,
      name: bot.name,
    });
    const cross = await api(srv, `/api/memory?scope=agent&scopeId=${peer.id}`, {
      bearer: token,
    });
    expect(asNamed(cross.body)).toMatchObject({
      scopeId: peer.id,
      name: peer.name,
    });

    // A member cookie: omitted scopeId defaults to its own user; explicit
    // other user resolves to that user.
    const mine = await api(srv, "/api/memory?scope=member", {
      rawSessionId: member.rawSessionId,
    });
    expect(mine.status).toBe(200);
    expect(asNamed(mine.body)).toMatchObject({
      scopeId: memberId,
      name: getUserByName("Member")!.name,
    });
    const theirs = await api(
      srv,
      `/api/memory?scope=member&scopeId=${ownerId}`,
      {
        rawSessionId: member.rawSessionId,
      },
    );
    expect(theirs.status).toBe(200);
    expect(asNamed(theirs.body)).toMatchObject({
      scopeId: ownerId,
      name: getUserByName("Morgan")!.name,
    });

    const office = await api(srv, "/api/memory?scope=office", {
      bearer: token,
    });
    expect(office.status).toBe(200);
    expect(asNamed(office.body)).toMatchObject({ scopeId: null, name: null });

    for (const [query, code] of [
      ["scope=room&scopeId=deadbeef", "room_not_found"],
      ["scope=agent&scopeId=deadbeef", "agent_not_found"],
      ["scope=member&scopeId=deadbeef", "user_not_found"],
    ]) {
      const r = await api(srv, `/api/memory?${query}`, { bearer: token });
      expect(r.status).toBe(404);
      expect(errCode(r.body)).toBe(code);
    }
  });
});

describe("routes/memory REST: access follows the rooms", () => {
  async function spawnIn(
    srv: TestServer,
    name: string,
    roomId: string,
    userId: string,
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
      undefined,
      userId,
    );
    if (!info) throw new Error(`spawn ${name} returned null`);
    return info;
  }

  // Morgan owns the office. Mia and Nora share room A, Pat has room B, Quinn
  // shares room D with Mia. Every member also reaches the lobby, which is not
  // a shared room.
  async function office() {
    const srv = await startTestServer();
    server = srv;
    const morgan = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const nora = await srv.seedMember("Nora");
    const pat = await srv.seedMember("Pat");
    const quinn = await srv.seedMember("Quinn");
    const id = (name: string) => getUserByName(name)!.id;
    const roomA = srv.agentManager.createRoom("Alpha");
    const roomB = srv.agentManager.createRoom("Beta");
    const roomD = srv.agentManager.createRoom("Delta");
    srv.agentManager.ensureLobby();
    for (const [name, rooms] of [
      ["Mia", [roomA, roomD]],
      ["Nora", [roomA]],
      ["Pat", [roomB]],
      ["Quinn", [roomD]],
    ] as const) {
      expect(updateUserById(id(name), { allowedRooms: [...rooms] }).ok).toBe(
        true,
      );
    }
    const miaBot = await spawnIn(srv, "MiaBot", roomA, id("Mia"));
    const miaBot2 = await spawnIn(srv, "MiaBot2", roomA, id("Mia"));
    const noraBot = await spawnIn(srv, "NoraBot", roomA, id("Nora"));
    const patBot = await spawnIn(srv, "PatBot", roomB, id("Pat"));
    const morganBot = await spawnIn(srv, "MorganBot", roomB, id("Morgan"));
    const apiToken = async (name: string, rooms?: string[]) =>
      (
        await mintApiToken({
          userId: id(name),
          name,
          expiresInDays: null,
          ...(rooms ? { limits: { rooms } } : {}),
        })
      ).token;
    const callers = {
      mia: { rawSessionId: mia.rawSessionId },
      miaBot: { bearer: mintAgentToken(miaBot.id, id("Mia")) },
      miaBot2: { bearer: mintAgentToken(miaBot2.id, id("Mia")) },
      miaNoRooms: { bearer: await apiToken("Mia", []) },
      nora: { rawSessionId: nora.rawSessionId },
      noraBot: { bearer: mintAgentToken(noraBot.id, id("Nora")) },
      noraInA: { bearer: await apiToken("Nora", [roomA]) },
      pat: { rawSessionId: pat.rawSessionId },
      patBot: { bearer: mintAgentToken(patBot.id, id("Pat")) },
      quinn: { rawSessionId: quinn.rawSessionId },
      morgan: { rawSessionId: morgan.rawSessionId },
      morganBot: { bearer: mintAgentToken(morganBot.id, id("Morgan")) },
      // An owner's room-limited token has no owner reach.
      morganInB: { bearer: await apiToken("Morgan", [roomB]) },
    };
    return { srv, id, roomA, roomB, roomD, miaBot, callers };
  }
  type Office = Awaited<ReturnType<typeof office>>;
  type Auth = { rawSessionId?: string; bearer?: string };

  const grade = (r: Res) =>
    errCode(r.body) ? `${r.status} ${errCode(r.body)}` : `${r.status}`;

  let n = 0;
  // Read, append and replace (a stale version: an allowed replace is a 409
  // and writes nothing) as one caller. A refused append leaves no trace,
  // checked through the owner's read.
  async function probe(
    o: Office,
    scope: string,
    scopeId: string,
    auth: Auth,
  ): Promise<string> {
    const text = `probe note ${++n}`;
    const path = `/api/memory?scope=${scope}&scopeId=${scopeId}`;
    const read = await api(o.srv, path, auth);
    const append = await api(o.srv, "/api/memory", {
      ...auth,
      method: "POST",
      body: { scope, scopeId, text },
    });
    const replace = await api(o.srv, "/api/memory", {
      ...auth,
      method: "PUT",
      body: { scope, scopeId, text: "replaced\n", version: "000000000000" },
    });
    const stored = await api(o.srv, path, o.callers.morgan);
    expect(stored.status).toBe(200);
    expect([text, asRead(stored.body).text.includes(text)]).toEqual([
      text,
      append.status === 201,
    ]);
    return [grade(read), grade(append), grade(replace)].join(" | ");
  }

  async function matrix(
    o: Office,
    scope: string,
    scopeId: string,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [who, auth] of Object.entries(o.callers))
      out[who] = await probe(o, scope, scopeId, auth);
    return out;
  }

  const FULL = "200 | 201 | 409 memory_conflict";
  const READ_ONLY =
    "200 | 403 memory_write_forbidden | 403 memory_write_forbidden";
  const none = (code: string) => `404 ${code} | 404 ${code} | 404 ${code}`;

  it("member memory: read by whoever shares a room with the member, written by the member's own identities and owners", async () => {
    const o = await office();
    expect(await matrix(o, "member", o.id("Mia"))).toEqual({
      mia: FULL,
      miaBot: FULL,
      miaBot2: FULL,
      // The member's own room-limited token: its own member memory.
      miaNoRooms: FULL,
      nora: READ_ONLY,
      noraBot: READ_ONLY,
      noraInA: READ_ONLY,
      // Pat reaches only B and the lobby.
      pat: none("user_not_found"),
      patBot: none("user_not_found"),
      quinn: READ_ONLY,
      morgan: FULL,
      morganBot: FULL,
      morganInB: none("user_not_found"),
    });
    // An owner reaches every room, so any member with a room shares one with
    // the owner. A token limited to no rooms shares none.
    const owners = await matrix(o, "member", o.id("Morgan"));
    expect({
      pat: owners.pat,
      noraBot: owners.noraBot,
      miaNoRooms: owners.miaNoRooms,
      morganBot: owners.morganBot,
      morganInB: owners.morganInB,
    }).toEqual({
      pat: READ_ONLY,
      noraBot: READ_ONLY,
      miaNoRooms: none("user_not_found"),
      morganBot: FULL,
      morganInB: FULL,
    });
  });

  it("room memory: whoever reaches the room", async () => {
    const o = await office();
    expect(await matrix(o, "room", o.roomA)).toEqual({
      mia: FULL,
      miaBot: FULL,
      miaBot2: FULL,
      miaNoRooms: none("room_not_found"),
      nora: FULL,
      noraBot: FULL,
      noraInA: FULL,
      pat: none("room_not_found"),
      patBot: none("room_not_found"),
      quinn: none("room_not_found"),
      morgan: FULL,
      morganBot: FULL,
      morganInB: none("room_not_found"),
    });
  });

  it("agent memory: written by the agent and whoever edits its instructions; read also by whoever reaches its room", async () => {
    const o = await office();
    expect(await matrix(o, "agent", o.miaBot.id)).toEqual({
      // The agent itself, a standard agent.
      miaBot: FULL,
      mia: FULL,
      // Standard agents have no agent:manage, so they cannot edit its
      // instructions, whoever manages them.
      miaBot2: READ_ONLY,
      // The manager's token reaches the agent only in a room it reaches.
      miaNoRooms: none("agent_not_found"),
      // Another member who reaches the agent's room edits its instructions.
      nora: FULL,
      noraBot: READ_ONLY,
      noraInA: FULL,
      pat: none("agent_not_found"),
      patBot: none("agent_not_found"),
      quinn: none("agent_not_found"),
      morgan: FULL,
      morganBot: READ_ONLY,
      morganInB: none("agent_not_found"),
    });
  });

  it("agent memory: a privileged agent writes it where it reaches the room, and a token's agentManagement level decides the write", async () => {
    const o = await office();
    const priv = async (name: string, roomId: string, manager: string) =>
      mintAgentToken(
        (await spawnIn(o.srv, name, roomId, o.id(manager))).id,
        o.id(manager),
        true,
      );
    const token = async (agentManagement: "read" | "write") =>
      (
        await mintApiToken({
          userId: o.id("Nora"),
          name: `nora-${agentManagement}`,
          expiresInDays: null,
          limits: { areas: { memory: "write", agentManagement } },
        })
      ).token;
    const out: Record<string, string> = {};
    for (const [who, bearer] of [
      ["noraPrivInA", await priv("NoraPriv", o.roomA, "Nora")],
      ["patPrivInB", await priv("PatPriv", o.roomB, "Pat")],
      ["morganPrivInB", await priv("MorganPriv", o.roomB, "Morgan")],
      ["noraManagesRead", await token("read")],
      ["noraManagesWrite", await token("write")],
    ] as const)
      out[who] = await probe(o, "agent", o.miaBot.id, { bearer });
    expect(out).toEqual({
      noraPrivInA: FULL,
      patPrivInB: none("agent_not_found"),
      morganPrivInB: FULL,
      noraManagesRead: READ_ONLY,
      noraManagesWrite: FULL,
    });
  });

  it("is checked live: a closed room is no longer shared, and a manager who loses the agent's room loses its memory", async () => {
    const o = await office();
    const { callers } = o;
    expect(await probe(o, "member", o.id("Mia"), callers.quinn)).toBe(
      READ_ONLY,
    );
    expect(o.srv.agentManager.closeRoom(o.roomD)).toBe(true);
    expect(await probe(o, "member", o.id("Mia"), callers.quinn)).toBe(
      none("user_not_found"),
    );

    expect(updateUserById(o.id("Mia"), { allowedRooms: [] }).ok).toBe(true);
    // Mia lost room A, and her agent still sits there.
    expect(await probe(o, "room", o.roomA, callers.mia)).toBe(
      none("room_not_found"),
    );
    expect(o.srv.agentManager.getAgent(o.miaBot.id)!.roomId).toBe(o.roomA);
    expect(await probe(o, "agent", o.miaBot.id, callers.mia)).toBe(
      none("agent_not_found"),
    );
    // Mia shares no room with Nora any more.
    expect(await probe(o, "member", o.id("Mia"), callers.nora)).toBe(
      none("user_not_found"),
    );
  });
});
