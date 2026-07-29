// Storage retention on the unified REST surface (task 2366ccb0).
//
// GET  /api/storage/usage  office:read + authenticated — humans and privileged
//                          agents; per-agent detail is owner-only.
// POST /api/storage/prune  office:admin + officeOwner, DRY RUN unless the body
//                          says apply:true.
//
// The harness boots against a temp state root, so the fixtures these tests
// write (and the one apply-path deletion) never touch the real ~/.isomux.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, utimesSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: Record<string, unknown> | null;
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
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
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

const DAY_MS = 24 * 60 * 60 * 1000;

// Log dir for an agent that no longer exists, holding two ancient transcripts.
// Backdated so an age-based policy reaches them.
function seedOldLogs(stateRoot: string, agentId = "agent-ghost") {
  const dir = join(stateRoot, "logs", agentId);
  mkdirSync(join(dir, "files"), { recursive: true });
  const aged = (Date.now() - 400 * DAY_MS) / 1000;
  for (const name of ["old-a.jsonl", "old-b.jsonl"]) {
    const p = join(dir, name);
    writeFileSync(p, '{"id":"1"}\n');
    utimesSync(p, aged, aged);
  }
  const att = join(dir, "files", "old.png");
  writeFileSync(att, "x".repeat(64));
  utimesSync(att, aged, aged);
  return dir;
}

describe("routes/storage.usage REST", () => {
  it("owner -> 200 with per-agent detail; member -> aggregates only", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    seedOldLogs(srv.stateRoot);

    const r = await api(srv, "/api/storage/usage", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);
    const b = r.body!;
    expect(b.stateRoot).toBe(srv.stateRoot);
    expect(typeof b.stateRootBytes).toBe("number");
    const categories = b.categories as { id: string; bytes: number }[];
    expect(categories.map((c) => c.id)).toEqual([
      "transcripts",
      "attachments",
      "session-metadata",
      "codex-home",
      "cronjobs",
      "memory",
      "other-state",
      "backups",
      "update-snapshots",
    ]);
    const agents = b.agents as { agentId: string }[];
    expect(agents.some((a) => a.agentId === "agent-ghost")).toBe(true);

    // A member holds office:read but is not the owner: aggregates only, so the
    // response never enumerates agents in rooms they cannot see.
    const m = await api(srv, "/api/storage/usage", {
      rawSessionId: member.rawSessionId,
    });
    expect(m.status).toBe(200);
    expect(m.body!.agents).toEqual([]);
    expect(m.body!.stateRoot).toBeNull();
    const memberCats = m.body!.categories as {
      path: string | null;
      bytes: number;
    }[];
    expect(memberCats.every((c) => c.path === null)).toBe(true);
    // Sizes are identical — only the layout and the agent list are withheld.
    expect(memberCats.map((c) => c.bytes)).toEqual(
      categories.map((c) => c.bytes),
    );
  });

  it("plain agent -> 403; privileged agent -> 200 without per-agent detail; no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];

    const plain = await spawnAgent(srv, "Worker", room.id);
    expect(
      (
        await api(srv, "/api/storage/usage", {
          bearer: getAgentTokenRaw(plain.id)!,
        })
      ).status,
    ).toBe(403);

    const ops = await spawnAgent(srv, "Ops", room.id);
    await srv.agentManager.setPrivileged(ops.id, true);
    const r = await api(srv, "/api/storage/usage", {
      bearer: getAgentTokenRaw(ops.id)!,
    });
    expect(r.status).toBe(200);
    // Scope is "agent" no matter how privileged, so it never gets the detail.
    expect(r.body!.agents).toEqual([]);

    expect((await api(srv, "/api/storage/usage")).status).toBe(401);
  });
});

describe("routes/storage.prune REST", () => {
  it("is a dry run by default: returns a plan, deletes nothing", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const dir = seedOldLogs(srv.stateRoot);

    const r = await api(srv, "/api/storage/prune", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { target: "transcripts", olderThanDays: 30, keepPerAgent: 0 },
    });
    expect(r.status).toBe(200);
    expect(r.body!.applied).toBeNull();
    const plan = r.body!.plan as { candidates: { path: string }[] };
    // Paths are relative to the logs dir, never absolute.
    expect(plan.candidates.map((c) => c.path).sort()).toEqual([
      "agent-ghost/old-a.jsonl",
      "agent-ghost/old-b.jsonl",
    ]);
    expect(existsSync(join(dir, "old-a.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "old-b.jsonl"))).toBe(true);
  });

  it("deletes only when apply is true, and only the planned files", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const dir = seedOldLogs(srv.stateRoot);

    const r = await api(srv, "/api/storage/prune", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        target: "transcripts",
        olderThanDays: 30,
        keepPerAgent: 1,
        apply: true,
      },
    });
    expect(r.status).toBe(200);
    const applied = r.body!.applied as { deleted: number; refused: unknown[] };
    expect(applied.deleted).toBe(1);
    expect(applied.refused).toEqual([]);
    // keepPerAgent: 1 spared the newer of the two; the attachment is untouched
    // because this call targeted transcripts.
    const survivors = ["old-a.jsonl", "old-b.jsonl"].filter((n) =>
      existsSync(join(dir, n)),
    );
    expect(survivors).toHaveLength(1);
    expect(existsSync(join(dir, "files", "old.png"))).toBe(true);
  });

  it("rejects a bad target, a zero age, and a non-boolean apply", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");

    const bad = async (body: unknown) =>
      api(srv, "/api/storage/prune", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body,
      });

    expect((await bad({ target: "codex-home", olderThanDays: 30 })).status).toBe(
      400,
    );
    expect((await bad({ target: "transcripts", olderThanDays: 0 })).status).toBe(
      400,
    );
    expect(
      (await bad({ target: "transcripts", olderThanDays: 1.5 })).status,
    ).toBe(400);
    expect(
      (
        await bad({
          target: "transcripts",
          olderThanDays: 30,
          keepPerAgent: -1,
        })
      ).status,
    ).toBe(400);
    expect(
      (await bad({ target: "transcripts", olderThanDays: 30, apply: "yes" }))
        .status,
    ).toBe(400);
  });

  it("refuses a transcript apply that omits keepPerAgent", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const dir = seedOldLogs(srv.stateRoot);

    // A dry run may omit it (0 is fine to explore with)...
    const dry = await api(srv, "/api/storage/prune", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { target: "transcripts", olderThanDays: 30 },
    });
    expect(dry.status).toBe(200);

    // ...but a delete must state the retention floor rather than inherit 0.
    const r = await api(srv, "/api/storage/prune", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { target: "transcripts", olderThanDays: 30, apply: true },
    });
    expect(r.status).toBe(400);
    expect((r.body!.error as { code: string }).code).toBe(
      "keep_per_agent_required",
    );
    expect(existsSync(join(dir, "old-a.jsonl"))).toBe(true);
  });

  it("member -> 403, privileged agent -> 403, no id -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const ops = await spawnAgent(srv, "Ops", room.id);
    await srv.agentManager.setPrivileged(ops.id, true);
    const body = { target: "transcripts", olderThanDays: 30 };

    expect(
      (
        await api(srv, "/api/storage/prune", {
          method: "POST",
          rawSessionId: member.rawSessionId,
          body,
        })
      ).status,
    ).toBe(403);
    // office:admin is deliberately excluded from the privileged-agent set.
    expect(
      (
        await api(srv, "/api/storage/prune", {
          method: "POST",
          bearer: getAgentTokenRaw(ops.id)!,
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(srv, "/api/storage/prune", { method: "POST", body })).status,
    ).toBe(401);
  });

  it("refuses an attachment apply while message-queues.json is unreadable", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const dir = seedOldLogs(srv.stateRoot);
    const attachment = join(dir, "files", "old.png");

    // Sanity: with a valid (absent) queue file, the orphan IS prunable.
    const before = await api(srv, "/api/storage/prune", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { target: "attachments", olderThanDays: 30 },
    });
    expect(before.status).toBe(200);
    expect(
      (before.body!.plan as { candidates: unknown[] }).candidates,
    ).toHaveLength(1);

    // Now corrupt it. Unknown must not read as "nothing is queued".
    writeFileSync(join(srv.stateRoot, "message-queues.json"), "{not json");

    const dry = await api(srv, "/api/storage/prune", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { target: "attachments", olderThanDays: 30 },
    });
    expect(dry.status).toBe(200);
    const plan = dry.body!.plan as {
      candidates: unknown[];
      skipped: { reason: string }[];
    };
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.some((s) => s.reason === "queue-state-unknown")).toBe(
      true,
    );

    // And an apply is refused loudly rather than reporting a silent "deleted 0".
    const applied = await api(srv, "/api/storage/prune", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { target: "attachments", olderThanDays: 30, apply: true },
    });
    expect(applied.status).toBe(409);
    expect((applied.body!.error as { code: string }).code).toBe(
      "queue_state_unreadable",
    );
    expect(existsSync(attachment)).toBe(true);
  });

  it("never proposes a live agent's active session", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    // Spawn is lazy — no session until a message wakes it.
    const enq = srv.agentManager.enqueueMessage(agent.id, {
      sender: { kind: "user", username: "Boss" },
      text: "wake",
    });
    expect(enq.ok).toBe(true);
    let sessionId: string | null = null;
    for (let i = 0; i < 200 && sessionId === null; i++) {
      sessionId = srv.agentManager.getCurrentSessionId(agent.id);
      if (sessionId === null) await new Promise((r) => setTimeout(r, 10));
    }
    expect(sessionId).toBeTruthy();

    // Backdate the live agent's own transcript past any plausible cutoff.
    const relative = `${agent.id}/${sessionId}.jsonl`;
    const path = join(srv.stateRoot, "logs", relative);
    mkdirSync(join(srv.stateRoot, "logs", agent.id), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '{"id":"1"}\n');
    const aged = (Date.now() - 400 * DAY_MS) / 1000;
    utimesSync(path, aged, aged);

    const r = await api(srv, "/api/storage/prune", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        target: "transcripts",
        olderThanDays: 1,
        keepPerAgent: 0,
        apply: true,
      },
    });
    expect(r.status).toBe(200);
    const plan = r.body!.plan as {
      candidates: { path: string }[];
      skipped: { reason: string; count: number }[];
    };
    expect(plan.candidates.map((c) => c.path)).not.toContain(relative);
    expect(plan.skipped.some((s) => s.reason === "active-session")).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});
