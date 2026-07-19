// Per-user skill/command-use counters (task f1769b1a): the increment at the
// slash dispatch site + GET /api/skill-usage on the unified REST surface.
// Seam: startTestServer() + FakeBackend (skill turns auto-complete). Zero LLM.
//
// What this freezes:
//   - A user-invoked bundled skill AND a built-in command each increment that
//     USER's counter under the invoked name (the Sk menu ranks across both);
//     counts are per-user (another user still reads {}).
//   - The route serves only the CALLER's own counts (identity-keyed, no param).
//   - Auth: plain AGENT bearer 403 (no office:read); no identity 401.
//   - The store module: copies out (no aliasing into the live store) and
//     sanitizes a corrupted file to empty instead of crashing.

import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { STATE_ROOT } from "../config.ts";
import {
  recordSkillUse,
  getSkillUseCounts,
  _testResetSkillUsage,
} from "../skill-usage.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 3000,
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

async function getCounts(
  srv: TestServer,
  opts: { bearer?: string; rawSessionId?: string } = {},
): Promise<{ status: number; counts: Record<string, number> | undefined }> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  const res = await srv.http("/api/skill-usage", {
    headers,
    rawSessionId: opts.rawSessionId,
  });
  let counts: Record<string, number> | undefined;
  try {
    counts = ((await res.json()) as { counts?: Record<string, number> }).counts;
  } catch {
    counts = undefined;
  }
  return { status: res.status, counts };
}

describe("skill-use counters: dispatch increment + GET /api/skill-usage", () => {
  it("counts a user's skill invocations per-user and serves only the caller's own", async () => {
    const srv = await startTestServer({});
    server = srv;
    const boss = await srv.seedOwner("Boss");
    const friend = await srv.seedMember("Friend");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);

    // Nothing used yet: both users read empty maps.
    let r = await getCounts(srv, { rawSessionId: boss.rawSessionId });
    expect(r.status).toBe(200);
    expect(r.counts?.["grill-me"]).toBeUndefined();

    // Boss invokes a bundled skill twice (each expands to a prompt and runs a
    // FakeBackend turn; wait for idle between so the second isn't queued).
    for (let i = 0; i < 2; i++) {
      await srv.agentManager.sendMessage(agent.id, "/grill-me", "Boss");
      await waitUntil(
        () => {
          const s = srv.agentManager.getAgent(agent.id)?.state;
          return s !== undefined && s !== "thinking" && s !== "tool_executing";
        },
        3000,
        `skill turn ${i}`,
      );
    }

    // Built-in COMMANDS count too — the Sk menu ranks across skills and
    // commands (/help dispatches immediately, no turn to await).
    await srv.agentManager.sendMessage(agent.id, "/help", "Boss");

    r = await getCounts(srv, { rawSessionId: boss.rawSessionId });
    expect(r.status).toBe(200);
    expect(r.counts?.["grill-me"]).toBe(2);
    expect(r.counts?.["help"]).toBe(1);

    // Per-user: Friend's own counts are untouched by Boss's uses.
    r = await getCounts(srv, { rawSessionId: friend.rawSessionId });
    expect(r.status).toBe(200);
    expect(r.counts?.["grill-me"]).toBeUndefined();

    // Persistence: a no-wipe restart (cold reboot on the same STATE_ROOT)
    // resets the module cache and re-reads skill-usage.json — the counts
    // survive. (Asserted at the module layer: the harness cookie session does
    // not survive a restart, so the route can't be probed with boss's cookie.)
    const bossUserId = getUserByName(boss.username)!.id;
    const restarted = await srv.restart();
    server = restarted;
    expect(getSkillUseCounts(bossUserId)["grill-me"]).toBe(2);
  });

  it("rejects a plain agent bearer (403) and anonymous callers (401); a wiped boot starts at zero", async () => {
    const srv = await startTestServer({});
    server = srv;
    const boss = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    expect((await getCounts(srv, { bearer: token })).status).toBe(403);
    expect((await getCounts(srv)).status).toBe(401);

    // Isolation: this boot wiped STATE_ROOT and reset the module cache, so the
    // previous test's counts are gone (pins the harness _testResetSkillUsage).
    const r = await getCounts(srv, { rawSessionId: boss.rawSessionId });
    expect(r.status).toBe(200);
    expect(r.counts).toEqual({});
  });
});

describe("skill-usage store module", () => {
  it("returns copies and survives a corrupted file (sanitized to empty)", () => {
    const file = join(STATE_ROOT, "skill-usage.json");

    _testResetSkillUsage();
    writeFileSync(file, "{ not json !!!");
    expect(getSkillUseCounts("user-x")).toEqual({});

    recordSkillUse("user-x", "tdd");
    recordSkillUse("user-x", "tdd");
    const counts = getSkillUseCounts("user-x");
    expect(counts).toEqual({ tdd: 2 });
    // Mutating the returned object must not leak into the store.
    counts.tdd = 999;
    expect(getSkillUseCounts("user-x")).toEqual({ tdd: 2 });

    // Malformed entries are dropped on load; well-formed ones survive.
    _testResetSkillUsage();
    writeFileSync(
      file,
      JSON.stringify({
        "user-x": { tdd: 2, bogus: "nope", negative: -3 },
        "user-y": "not-an-object",
      }),
    );
    expect(getSkillUseCounts("user-x")).toEqual({ tdd: 2 });
    expect(getSkillUseCounts("user-y")).toEqual({});

    // Leave a clean slate for any later test in this process.
    _testResetSkillUsage();
    writeFileSync(file, "{}");
  });

  it("treats Object.prototype-named skills as ordinary keys (filesystem-derived names)", () => {
    const file = join(STATE_ROOT, "skill-usage.json");
    _testResetSkillUsage();
    writeFileSync(file, "{}");

    // A skill directory can legally be named "constructor" / "toString" /
    // "__proto__" — none may collide with inherited Object.prototype members
    // (which would corrupt the `?? 0` increment read).
    recordSkillUse("user-z", "constructor");
    recordSkillUse("user-z", "constructor");
    recordSkillUse("user-z", "toString");
    recordSkillUse("user-z", "__proto__");
    const counts = getSkillUseCounts("user-z");
    expect(counts["constructor"]).toBe(2);
    expect(counts["toString"]).toBe(1);
    expect(counts["__proto__"]).toBe(1);

    // And they survive the JSON round-trip on a cold reload.
    _testResetSkillUsage();
    const reloaded = getSkillUseCounts("user-z");
    expect(reloaded["constructor"]).toBe(2);
    expect(reloaded["toString"]).toBe(1);
    expect(reloaded["__proto__"]).toBe(1);
    // A user id that shadows a prototype name is likewise an ordinary key.
    expect(getSkillUseCounts("hasOwnProperty")).toEqual(
      Object.create(null) as Record<string, number>,
    );

    _testResetSkillUsage();
    writeFileSync(file, "{}");
  });
});
