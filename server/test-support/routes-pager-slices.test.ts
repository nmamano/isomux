// Resolved pages through the real routes (task af346c0c): GET /api/pager
// returns open and acked pages whole and resolved pages one slice at a time
// (limit, before), visibility before the limit; an archived page keeps its
// GET, ack and resolve answers.
//
// Seam: startTestServer(). The members have no Discord webhook, so a resolve
// records its "resolved" message as not sent at once and the page moves to
// STATE_ROOT/pager-resolved.jsonl. Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { PagerEntry } from "../../shared/types.ts";

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
  init: { method?: string; rawSessionId?: string; bearer?: string; body?: unknown } = {},
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

async function spawnAgent(srv: TestServer, name: string, roomId: string) {
  const userId = getUserByName("Boss")!.id;
  const agent = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    "Boss",
    "claude",
    undefined,
    userId,
  );
  if (!agent) throw new Error(`spawn ${name} returned null`);
  return { agent, token: mintAgentToken(agent.id, userId) };
}

// Owner Boss; member Mia with room B only; Bot in room A, BBot in room B.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const boss = await srv.seedOwner("Boss");
  const mia = await srv.seedMember("Mia");
  const roomA = srv.agentManager.getRooms()[0].id;
  const roomB = srv.agentManager.createRoom("Room B");
  updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
  const bot = await spawnAgent(srv, "Bot", roomA);
  const bBot = await spawnAgent(srv, "BBot", roomB);
  return { srv, boss, mia, bot, bBot };
}

const archivedIds = (srv: TestServer): string[] => {
  const path = join(srv.stateRoot, "pager-resolved.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as PagerEntry).id);
};

// Raise one page per title and resolve each, in order, then wait until all
// of them are in the archive.
async function raiseAndResolve(
  srv: TestServer,
  token: string,
  bossSession: string,
  titles: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const title of titles) {
    const r = await api(srv, "/api/pager", {
      method: "POST",
      bearer: token,
      body: { title },
    });
    const id = (r.body as PagerEntry).id;
    await api(srv, `/api/pager/${id}/resolve`, {
      method: "POST",
      rawSessionId: bossSession,
    });
    const deadline = Date.now() + 5000;
    while (!archivedIds(srv).includes(id)) {
      if (Date.now() > deadline) throw new Error(`${id} never archived`);
      await new Promise((r) => setTimeout(r, 5));
    }
    out.push(id);
    // Distinct resolve times, so resolve order is the order of this list.
    await new Promise((r) => setTimeout(r, 2));
  }
  return out;
}

const listIds = async (srv: TestServer, session: string, q: string) => {
  const r = await api(srv, `/api/pager${q}`, { rawSessionId: session });
  expect(r.status).toBe(200);
  return (r.body as PagerEntry[]).map((e) => e.id);
};

describe("pager REST: resolved slices", () => {
  it("newest-archived first, with limit and before; open and acked pages whole", async () => {
    const { srv, boss, bot } = await office();
    const [p1, p2, p3, p4, p5] = await raiseAndResolve(
      srv,
      bot.token,
      boss.rawSessionId,
      ["1", "2", "3", "4", "5"],
    );
    const open = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: bot.token,
        body: { title: "open" },
      })
    ).body as PagerEntry;
    // Enabling condition: the resolved pages left pager.json.
    const onDisk = JSON.parse(
      readFileSync(join(srv.stateRoot, "pager.json"), "utf-8"),
    ) as PagerEntry[];
    expect(onDisk.map((e) => e.id)).toEqual([open.id]);

    const s = boss.rawSessionId;
    expect(await listIds(srv, s, "?state=resolved&limit=2")).toEqual([p5, p4]);
    expect(await listIds(srv, s, `?state=resolved&limit=2&before=${p4}`)).toEqual(
      [p3, p2],
    );
    expect(await listIds(srv, s, `?state=resolved&limit=2&before=${p2}`)).toEqual(
      [p1],
    );
    expect(await listIds(srv, s, "?state=all&limit=2")).toEqual([open.id, p5, p4]);
    expect(await listIds(srv, s, "")).toEqual([open.id]);
  });

  it("the default slice is 50", async () => {
    const { srv, boss, bot } = await office();
    const titles = Array.from({ length: 51 }, (_, i) => `t${i}`);
    const resolved = await raiseAndResolve(srv, bot.token, boss.rawSessionId, titles);
    const got = await listIds(srv, boss.rawSessionId, "?state=resolved");
    expect(got).toEqual(resolved.slice(1).reverse());
    const all = await listIds(srv, boss.rawSessionId, "?state=all");
    expect(all).toHaveLength(50);
  });

  it("a bad limit or before is 400, and an unknown and an invisible cursor answer alike", async () => {
    const { srv, boss, mia, bot, bBot } = await office();
    const [hidden] = await raiseAndResolve(srv, bot.token, boss.rawSessionId, ["a"]);
    const [seen] = await raiseAndResolve(srv, bBot.token, boss.rawSessionId, ["b"]);
    const open = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: bBot.token,
        body: { title: "open" },
      })
    ).body as PagerEntry;
    for (const q of [
      "?state=resolved&limit=0",
      "?state=resolved&limit=201",
      "?state=resolved&limit=abc",
      "?state=resolved&limit=1.5",
      "?state=resolved&before=",
    ]) {
      const r = await api(srv, `/api/pager${q}`, { rawSessionId: boss.rawSessionId });
      expect(r.status).toBe(400);
    }
    expect(
      (await api(srv, "/api/pager?state=resolved&limit=200", {
        rawSessionId: boss.rawSessionId,
      })).status,
    ).toBe(200);
    // Mia sees room B only: the room A page is not in her list, and as a
    // cursor it is the same 400 as an id that does not exist.
    expect(await listIds(srv, mia.rawSessionId, "?state=resolved&limit=1")).toEqual([
      seen,
    ]);
    const invisible = await api(
      srv,
      `/api/pager?state=resolved&before=${hidden}`,
      { rawSessionId: mia.rawSessionId },
    );
    const unknown = await api(srv, "/api/pager?state=resolved&before=ffffffff", {
      rawSessionId: mia.rawSessionId,
    });
    const notResolved = await api(
      srv,
      `/api/pager?state=resolved&before=${open.id}`,
      { rawSessionId: mia.rawSessionId },
    );
    expect(invisible.status).toBe(400);
    expect(invisible.body).toEqual(unknown.body);
    expect(notResolved.body).toEqual(unknown.body);
  });

  it("visibility comes before the limit", async () => {
    const { srv, boss, mia, bot, bBot } = await office();
    const [q1] = await raiseAndResolve(srv, bBot.token, boss.rawSessionId, ["q1"]);
    // Newer pages Mia cannot see.
    await raiseAndResolve(srv, bot.token, boss.rawSessionId, ["x1", "x2", "x3"]);
    expect(await listIds(srv, mia.rawSessionId, "?state=resolved&limit=2")).toEqual([
      q1,
    ]);
  });
});

describe("pager REST: archived pages", () => {
  it("keep their GET, ack and resolve answers", async () => {
    const { srv, boss, mia, bot } = await office();
    const [id] = await raiseAndResolve(srv, bot.token, boss.rawSessionId, ["x"]);
    const s = boss.rawSessionId;
    const got = await api(srv, `/api/pager/${id}`, { rawSessionId: s });
    expect(got.status).toBe(200);
    expect((got.body as PagerEntry).state).toBe("resolved");
    const again = await api(srv, `/api/pager/${id}/resolve`, {
      method: "POST",
      rawSessionId: s,
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(got.body);
    const ack = await api(srv, `/api/pager/${id}/ack`, {
      method: "POST",
      rawSessionId: s,
    });
    expect(ack.status).toBe(409);
    expect((ack.body as { error?: { code?: string } }).error?.code).toBe(
      "already_resolved",
    );
    // The source agent resolves its own page: unchanged, 200.
    const bySource = await api(srv, `/api/pager/${id}/resolve`, {
      method: "POST",
      bearer: bot.token,
    });
    expect(bySource.status).toBe(200);
    // A member who cannot see the page gets the unknown-page answer.
    for (const path of [`/api/pager/${id}`, `/api/pager/${id}/resolve`, `/api/pager/${id}/ack`]) {
      const r = await api(srv, path, {
        method: path === `/api/pager/${id}` ? "GET" : "POST",
        rawSessionId: mia.rawSessionId,
      });
      expect(r.status).toBe(404);
    }
    // Still archived once.
    expect(archivedIds(srv).filter((x) => x === id)).toHaveLength(1);
  });

  it("survive a cold restart", async () => {
    const { srv, boss, bot } = await office();
    const [id] = await raiseAndResolve(srv, bot.token, boss.rawSessionId, ["x"]);
    const restarted = await srv.restart();
    server = restarted;
    expect(
      await listIds(restarted, boss.rawSessionId, "?state=resolved"),
    ).toEqual([id]);
    const got = await api(restarted, `/api/pager/${id}`, {
      rawSessionId: boss.rawSessionId,
    });
    expect(got.status).toBe(200);
  });
});
