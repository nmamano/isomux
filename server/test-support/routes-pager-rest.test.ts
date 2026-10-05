// Pager routes (opIds pager.*) through the real route table and server.
//
// Pins: source and target come from the agent's token and agent record, never
// the body; key dedupe over HTTP; room-access visibility for list, get, ack,
// resolve and the per-socket event; the source resolves its own page even
// without room access; pages survive a cold restart.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo, PagerEntry } from "../../shared/types.ts";

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

const errCode = (r: Res) =>
  (r.body as { error?: { code?: string } }).error?.code;

// Spawn an agent in `roomId`, managed by `managerName` (null: a legacy
// unowned agent), and mint its token the way the product does: bound to the
// agent's manager.
async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
  managerName: string | null,
): Promise<{ agent: AgentInfo; token: string }> {
  const userId = managerName ? getUserByName(managerName)!.id : null;
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
    managerName ?? undefined,
    "claude",
    undefined,
    userId,
  );
  if (!agent) throw new Error(`spawn ${name} returned null`);
  return { agent, token: mintAgentToken(agent.id, userId) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pagerEvents = (s: TestSocket): PagerEntry[] =>
  s.messages
    .filter((m) => (m as { type?: string }).type === "pager_upserted")
    .map((m) => (m as { entry: PagerEntry }).entry);

// One office: owner Boss; member Mia with access to room B only; Bot in room A
// managed by Boss.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const boss = await srv.seedOwner("Boss");
  const mia = await srv.seedMember("Mia");
  const roomA = srv.agentManager.getRooms()[0].id;
  const roomB = srv.agentManager.createRoom("Room B");
  updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
  const bot = await spawnAgent(srv, "Bot", roomA, "Boss");
  return { srv, boss, mia, roomA, roomB, bot };
}

describe("pager REST: raise", () => {
  it("source and target come from the token and agent record, not the body", async () => {
    const { srv, roomA, bot } = await office();
    const r = await api(srv, "/api/pager", {
      method: "POST",
      bearer: bot.token,
      body: {
        title: "Disk full",
        body: "90%",
        source: { kind: "agent", agentId: "spoof", name: "x", roomId: "x" },
        targetUserId: "spoof",
        state: "resolved",
      },
    });
    expect(r.status).toBe(201);
    const e = r.body as PagerEntry;
    expect(e.source).toEqual({
      kind: "agent",
      agentId: bot.agent.id,
      name: "Bot",
      roomId: roomA,
    });
    expect(e.targetUserId).toBe(getUserByName("Boss")!.id);
    expect(e.state).toBe("open");
    expect(e.delivery.state).toBe("not_delivered");
  });

  it("the target is the agent's recorded manager, not the token's user", async () => {
    const { srv, roomA } = await office();
    const { agent } = await spawnAgent(srv, "Bot2", roomA, "Boss");
    const token = mintAgentToken(agent.id, getUserByName("Mia")!.id);
    const r = await api(srv, "/api/pager", {
      method: "POST",
      bearer: token,
      body: { title: "x" },
    });
    expect(r.status).toBe(201);
    expect((r.body as PagerEntry).targetUserId).toBe(getUserByName("Boss")!.id);
  });

  it("the same key dedupes into the open page (200, not 201)", async () => {
    const { srv, bot } = await office();
    const raise = (title: string) =>
      api(srv, "/api/pager", {
        method: "POST",
        bearer: bot.token,
        body: { title, key: "disk" },
      });
    const first = await raise("Disk 90%");
    const second = await raise("Disk 95%");
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const e = second.body as PagerEntry;
    expect(e.id).toBe((first.body as PagerEntry).id);
    expect(e.raiseCount).toBe(2);
    expect(e.title).toBe("Disk 95%");
  });

  it("only an agent can raise; bad fields are 400; no manager is 409", async () => {
    const { srv, boss, roomA, bot } = await office();
    const asBoss = await api(srv, "/api/pager", {
      method: "POST",
      rawSessionId: boss.rawSessionId,
      body: { title: "x" },
    });
    expect(asBoss.status).toBe(403);
    const bad = await api(srv, "/api/pager", {
      method: "POST",
      bearer: bot.token,
      body: { title: "two\nlines" },
    });
    expect(bad.status).toBe(400);
    const orphan = await spawnAgent(srv, "Orphan", roomA, null);
    const r = await api(srv, "/api/pager", {
      method: "POST",
      bearer: orphan.token,
      body: { title: "x" },
    });
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("no_manager");
    expect(srv.agentManager.getAgent(orphan.agent.id)?.userId).toBeNull();
  });
});

describe("pager REST: visibility, ack and resolve", () => {
  it("a member without access to the source room cannot see or act on the page", async () => {
    const { srv, mia, bot } = await office();
    const miaWs = await srv.connectWs(mia.rawSessionId);
    const e = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: bot.token,
        body: { title: "x" },
      })
    ).body as PagerEntry;
    const list = await api(srv, "/api/pager", {
      rawSessionId: mia.rawSessionId,
    });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    for (const [method, path] of [
      ["GET", `/api/pager/${e.id}`],
      ["POST", `/api/pager/${e.id}/ack`],
      ["POST", `/api/pager/${e.id}/resolve`],
    ]) {
      const r = await api(srv, path, {
        method,
        rawSessionId: mia.rawSessionId,
      });
      expect(r.status).toBe(404);
    }
    expect(srv.agentManager.getAgent(bot.agent.id)).not.toBeNull();
    await sleep(50);
    expect(pagerEvents(miaWs)).toEqual([]);
  });

  it("a member with access acks and resolves; each change reaches their socket", async () => {
    const { srv, boss, bot } = await office();
    const bossWs = await srv.connectWs(boss.rawSessionId);
    const e = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: bot.token,
        body: { title: "x" },
      })
    ).body as PagerEntry;
    const ack = await api(srv, `/api/pager/${e.id}/ack`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    expect(ack.status).toBe(200);
    expect((ack.body as PagerEntry).acked?.by).toBe("Boss");
    const res = await api(srv, `/api/pager/${e.id}/resolve`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect((res.body as PagerEntry).state).toBe("resolved");
    const again = await api(srv, `/api/pager/${e.id}/ack`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    expect(again.status).toBe(409);
    expect(errCode(again)).toBe("already_resolved");
    await sleep(50);
    // The second "open" and the second "resolved" are delivery attempts (the
    // page, then the resolved message): the boss has no webhook.
    const events = pagerEvents(bossWs);
    expect(events.map((x) => x.state)).toEqual([
      "open",
      "open",
      "acked",
      "resolved",
      "resolved",
    ]);
    expect(events[1].delivery.lastFailure).toBe("no_webhook");
    expect(events[4].delivery).toMatchObject({
      lastFailure: "no_webhook",
      resolvedNotice: "done",
    });
  });

  it("the source resolves its own page even without access to its room", async () => {
    const { srv, roomA } = await office();
    // Mia's agent sits in room A, which Mia (and so her agent) cannot access.
    const miaBot = await spawnAgent(srv, "MiaBot", roomA, "Mia");
    const e = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: miaBot.token,
        body: { title: "x" },
      })
    ).body as PagerEntry;
    expect(
      (await api(srv, `/api/pager/${e.id}`, { bearer: miaBot.token })).status,
    ).toBe(404);
    expect(
      (
        await api(srv, `/api/pager/${e.id}/ack`, {
          method: "POST",
          bearer: miaBot.token,
        })
      ).status,
    ).toBe(404);
    const r = await api(srv, `/api/pager/${e.id}/resolve`, {
      method: "POST",
      bearer: miaBot.token,
    });
    expect(r.status).toBe(200);
    expect((r.body as PagerEntry).resolved?.by).toBe("MiaBot");
  });

  it("an agent without access to the source room cannot resolve another source's page", async () => {
    const { srv, boss, roomA, bot } = await office();
    const raised = await api(srv, "/api/pager", {
      method: "POST",
      bearer: bot.token,
      body: { title: "x" },
    });
    expect(raised.status).toBe(201);
    const e = raised.body as PagerEntry;
    // Mia's agent sits in room A too, but Mia (and so her agent) cannot
    // access it, and the page's source is Bot, not this agent.
    const miaBot = await spawnAgent(srv, "MiaBot", roomA, "Mia");
    expect(e.source).toMatchObject({ kind: "agent", agentId: bot.agent.id });
    expect(bot.agent.id).not.toBe(miaBot.agent.id);
    expect(
      (await api(srv, `/api/pager/${e.id}`, { bearer: miaBot.token })).status,
    ).toBe(404);
    const r = await api(srv, `/api/pager/${e.id}/resolve`, {
      method: "POST",
      bearer: miaBot.token,
    });
    expect(r.status).toBe(404);
    const after = await api(srv, `/api/pager/${e.id}`, {
      rawSessionId: boss.rawSessionId,
    });
    expect((after.body as PagerEntry).state).toBe("open");
  });

  it("another agent with access to the room can ack the page", async () => {
    const { srv, roomA, bot } = await office();
    const peer = await spawnAgent(srv, "Peer", roomA, "Boss");
    const e = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: bot.token,
        body: { title: "x" },
      })
    ).body as PagerEntry;
    const r = await api(srv, `/api/pager/${e.id}/ack`, {
      method: "POST",
      bearer: peer.token,
    });
    expect(r.status).toBe(200);
    expect((r.body as PagerEntry).acked?.by).toBe("Peer");
  });
});

describe("pager REST: list filters", () => {
  it("defaults to open+acked, newest raise first; state and roomId filter", async () => {
    const { srv, boss, roomA, roomB, bot } = await office();
    const bBot = await spawnAgent(srv, "BBot", roomB, "Boss");
    const raise = async (token: string, title: string) => {
      const r = await api(srv, "/api/pager", {
        method: "POST",
        bearer: token,
        body: { title },
      });
      await sleep(2); // distinct lastRaisedAt
      return r.body as PagerEntry;
    };
    const p1 = await raise(bot.token, "one");
    const p2 = await raise(bBot.token, "two");
    const p3 = await raise(bot.token, "three");
    await api(srv, `/api/pager/${p3.id}/resolve`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    const ids = async (q: string) => {
      const r = await api(srv, `/api/pager${q}`, {
        rawSessionId: boss.rawSessionId,
      });
      expect(r.status).toBe(200);
      return (r.body as PagerEntry[]).map((e) => e.id);
    };
    expect(await ids("")).toEqual([p2.id, p1.id]);
    expect(await ids("?state=all")).toEqual([p3.id, p2.id, p1.id]);
    expect(await ids("?state=resolved")).toEqual([p3.id]);
    expect(await ids(`?roomId=${roomA}`)).toEqual([p1.id]);
    const bad = await api(srv, "/api/pager?state=closed", {
      rawSessionId: boss.rawSessionId,
    });
    expect(bad.status).toBe(400);
    const empty = await api(srv, "/api/pager?roomId=", {
      rawSessionId: boss.rawSessionId,
    });
    expect(empty.status).toBe(400);
  });

  it("a room filter the caller cannot access is 404", async () => {
    const { srv, mia, roomA } = await office();
    const r = await api(srv, `/api/pager?roomId=${roomA}`, {
      rawSessionId: mia.rawSessionId,
    });
    expect(r.status).toBe(404);
  });
});

describe("pager REST: durability", () => {
  it("pages and their states survive a cold restart, and dedupe continues", async () => {
    const { srv, boss, bot } = await office();
    const first = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: bot.token,
        body: { title: "x", key: "k", body: "b" },
      })
    ).body as PagerEntry;
    const acked = (
      await api(srv, `/api/pager/${first.id}/ack`, {
        method: "POST",
        rawSessionId: boss.rawSessionId,
      })
    ).body as PagerEntry;
    const restarted = await srv.restart();
    server = restarted;
    const list = await api(restarted, "/api/pager", {
      rawSessionId: boss.rawSessionId,
    });
    expect(list.body).toEqual([acked]);
    const token = mintAgentToken(bot.agent.id, getUserByName("Boss")!.id);
    const again = await api(restarted, "/api/pager", {
      method: "POST",
      bearer: token,
      body: { title: "x", key: "k" },
    });
    expect(again.status).toBe(200);
    expect((again.body as PagerEntry).id).toBe(first.id);
    expect((again.body as PagerEntry).state).toBe("acked");
  });
});
