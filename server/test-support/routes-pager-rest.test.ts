// The compat pager routes over paged asks (task 74e8fc07, slice 3;
// server/routes/handlers/pager.ts): a page is a paged ask named by its page
// id. Agent and app raises, who sees and acts on a page, the lists, closed
// pages, and durability.
//
// Visibility is the ask's (the "Lost" rules of the task note): the member a
// page is for, an office owner as another member's, and the source agent;
// not every member or agent of the room. Only a member acks; the source
// agent or a member who may dismiss it resolves it.
//
// Seam: startTestServer() with a stub pagerFetch. Zero LLM, no Discord.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type {
  AgentInfo,
  AskMemberWire,
  PagerEntry,
  PagerSource,
} from "../../shared/types.ts";
import * as managers from "../office-managers.ts";
import { pagerHandlers } from "../routes/handlers/pager.ts";
import type { RouteHandlerContext } from "../routes/executor.ts";
import { createAskStore } from "../asks.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}
type Auth = { bearer?: string; rawSessionId?: string };

async function api(
  srv: TestServer,
  path: string,
  init: Auth & { method?: string; body?: unknown } = {},
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entryOf = (r: Res) => r.body as PagerEntry;

// Spawn an agent in `roomId`, managed by `managerName` (null: a legacy
// unowned agent), with a token bound to that manager, as the product mints.
async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
  managerName: string | null,
): Promise<{ agent: AgentInfo; token: string }> {
  const userId = managerName ? getUserByName(managerName)!.id : null;
  const agent = await srv.agentManager.spawn(
    name,
    srv.workDir,
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

const raise = (srv: TestServer, token: string, body: unknown) =>
  api(srv, "/api/pager", { method: "POST", bearer: token, body });
const act = (srv: TestServer, id: string, verb: "ack" | "resolve", who: Auth) =>
  api(srv, `/api/pager/${id}/${verb}`, { method: "POST", ...who });

// The member's own open asks.
async function asksOf(srv: TestServer, who: Auth): Promise<AskMemberWire[]> {
  const r = await api(srv, "/api/asks", who);
  expect(r.status).toBe(200);
  return r.body as AskMemberWire[];
}

// Ids of a GET /api/pager list.
async function listIds(srv: TestServer, who: Auth, q = ""): Promise<string[]> {
  const r = await api(srv, `/api/pager${q}`, who);
  expect(r.status).toBe(200);
  return (r.body as PagerEntry[]).map((e) => e.id);
}

// Whether the socket heard anything about this ask.
const heardAsk = (s: TestSocket, askId: string): boolean =>
  s.messages.some((m) => {
    const msg = m as { type?: string; id?: string; entry?: { id?: string } };
    return (
      typeof msg.type === "string" &&
      msg.type.includes("ask") &&
      (msg.id === askId || msg.entry?.id === askId)
    );
  });
const pagerEventCount = (s: TestSocket): number =>
  s.messages.filter((m) => (m as { type?: string }).type === "pager_upserted")
    .length;

// One office: owner Morgan; member Lee with room A; member Mia with room B
// only; Bot in room A, managed by Morgan.
async function office() {
  const sent: Array<{
    embeds?: Array<{ title: string; footer?: { text: string } }>;
  }> = [];
  const srv = await startTestServer({
    startServer: {
      pagerFetch: async (_url, init) => {
        sent.push(JSON.parse(init.body as string));
        return new Response(null, { status: 204 });
      },
    },
  });
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const lee = await srv.seedMember("Lee");
  const mia = await srv.seedMember("Mia");
  const roomA = srv.agentManager.getRooms()[0].id;
  const roomB = srv.agentManager.createRoom("Room B");
  updateUserById(getUserByName("Lee")!.id, { allowedRooms: [roomA] });
  updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
  const bot = await spawnAgent(srv, "Bot", roomA, "Morgan");
  const as = (s: { rawSessionId: string }): Auth => ({
    rawSessionId: s.rawSessionId,
  });
  return {
    srv,
    sent,
    morgan: as(morgan),
    lee: as(lee),
    mia: as(mia),
    roomA,
    roomB,
    bot,
    id: (name: string) => getUserByName(name)!.id,
  };
}

describe("agent pages", () => {
  describe("raise", () => {
    it("source and target come from the token and the agent record; the page is a P1 paged ask for the manager, named by its page id", async () => {
      const o = await office();
      const r = await raise(o.srv, o.bot.token, {
        title: "Disk full",
        body: "90%",
        source: { kind: "agent", agentId: "spoof", name: "x", roomId: "x" },
        targetUserId: "spoof",
        state: "resolved",
      });
      expect(r.status).toBe(201);
      const e = entryOf(r);
      expect(e.id).toMatch(/^[0-9a-f]{16}$/);
      expect(e.source).toEqual({
        kind: "agent",
        agentId: o.bot.agent.id,
        name: "Bot",
        roomId: o.roomA,
      });
      expect(e).toMatchObject({
        targetUserId: o.id("Morgan"),
        title: "Disk full",
        body: "90%",
        state: "open",
        raiseCount: 1,
      });
      expect(e.lastRaisedAt).toBe(e.createdAt);
      const ask = (await asksOf(o.srv, o.morgan)).find((a) => a.id === e.askId);
      expect(ask).toMatchObject({
        agentId: o.bot.agent.id,
        prompt: "Disk full\n\n90%",
        priority: "P1",
        page: { state: "ringing", pageId: e.id },
      });
    });

    it("the target is the agent's recorded manager, not the token's user", async () => {
      const o = await office();
      const { agent } = await spawnAgent(o.srv, "Bot2", o.roomA, "Morgan");
      const token = mintAgentToken(agent.id, o.id("Mia"));
      const r = await raise(o.srv, token, { title: "x" });
      expect(r.status).toBe(201);
      expect(entryOf(r).targetUserId).toBe(o.id("Morgan"));
    });

    it("the same key raises into the open page: 200, a higher count, the newest text; no key, or a new manager, opens another", async () => {
      const o = await office();
      const first = await raise(o.srv, o.bot.token, {
        title: "Disk 90%",
        body: "on /var",
        key: "disk",
      });
      expect(first.status).toBe(201);
      await sleep(2);
      const second = await raise(o.srv, o.bot.token, {
        title: "Disk 95%",
        key: "disk",
      });
      expect(second.status).toBe(200);
      const e = entryOf(second);
      expect([e.id, e.askId]).toEqual([
        entryOf(first).id,
        entryOf(first).askId,
      ]);
      expect(e.raiseCount).toBe(2);
      expect(e.lastRaisedAt).toBeGreaterThan(entryOf(first).lastRaisedAt);
      expect(e.title).toBe("Disk 95%");
      // An omitted body clears the old one.
      expect(e.body).toBeUndefined();
      const ask = (await asksOf(o.srv, o.morgan)).find((a) => a.id === e.askId);
      expect(ask?.prompt).toBe("Disk 95%");
      // The same text still counts.
      const third = await raise(o.srv, o.bot.token, {
        title: "Disk 95%",
        key: "disk",
      });
      expect([third.status, entryOf(third).raiseCount]).toEqual([200, 3]);

      const unkeyed = await raise(o.srv, o.bot.token, { title: "Disk 95%" });
      expect(unkeyed.status).toBe(201);
      expect(entryOf(unkeyed).id).not.toBe(e.id);

      // Lee manages Bot now: the key opens Lee's own page, and Morgan's stays.
      const moved = await o.srv.agentManager.setManager(
        o.bot.agent.id,
        o.id("Lee"),
        "Lee",
        "Morgan",
      );
      expect(moved?.userId).toBe(o.id("Lee"));
      // The move revokes the old token; the new one is bound to Lee.
      const leeToken = mintAgentToken(o.bot.agent.id, o.id("Lee"));
      const forLee = await raise(o.srv, leeToken, {
        title: "Disk 99%",
        key: "disk",
      });
      expect(forLee.status).toBe(201);
      expect(entryOf(forLee).targetUserId).toBe(o.id("Lee"));
      expect(entryOf(forLee).id).not.toBe(e.id);
      const morgans = await api(o.srv, `/api/pager/${e.id}`, o.morgan);
      expect(entryOf(morgans)).toMatchObject({
        raiseCount: 3,
        title: "Disk 95%",
      });
    });

    it("only an agent can raise; bad fields are 400; no manager is 409; none of them opens an ask", async () => {
      const o = await office();
      const asMorgan = await api(o.srv, "/api/pager", {
        method: "POST",
        ...o.morgan,
        body: { title: "x" },
      });
      expect(asMorgan.status).toBe(403);
      const bad = await raise(o.srv, o.bot.token, { title: "two\nlines" });
      expect(bad.status).toBe(400);
      const orphan = await spawnAgent(o.srv, "Orphan", o.roomA, null);
      const r = await raise(o.srv, orphan.token, { title: "x" });
      expect(r.status).toBe(409);
      expect(errCode(r)).toBe("no_manager");
      expect(o.srv.agentManager.getAgent(orphan.agent.id)?.userId).toBeNull();
      expect(await asksOf(o.srv, o.morgan)).toEqual([]);
    });

    it("past 50 open pages of one agent, 429 too_many_pages", async () => {
      const o = await office();
      for (let i = 0; i < 50; i++) {
        const r = await raise(o.srv, o.bot.token, { title: `t${i}` });
        expect(r.status).toBe(201);
      }
      const over = await raise(o.srv, o.bot.token, { title: "one more" });
      expect([over.status, errCode(over)]).toEqual([429, "too_many_pages"]);
      // A resolve makes room for one more.
      const oldest = (await listIds(o.srv, o.morgan)).at(-1)!;
      expect((await act(o.srv, oldest, "resolve", o.morgan)).status).toBe(200);
      expect((await raise(o.srv, o.bot.token, { title: "now" })).status).toBe(
        201,
      );
    });
  });

  describe("who sees and acts on a page", () => {
    it("its target sees, acks and resolves it; their socket hears the ask, and no socket hears a pager event", async () => {
      const o = await office();
      const ws = await o.srv.connectWs(o.morgan.rawSessionId!);
      const e = entryOf(await raise(o.srv, o.bot.token, { title: "x" }));
      expect(await listIds(o.srv, o.morgan)).toEqual([e.id]);
      expect((await api(o.srv, `/api/pager/${e.id}`, o.morgan)).status).toBe(
        200,
      );
      const ack = await act(o.srv, e.id, "ack", o.morgan);
      expect(ack.status).toBe(200);
      expect(entryOf(ack).state).toBe("acked");
      expect(entryOf(ack).acked?.by).toBe("Morgan");
      const ackAgain = await act(o.srv, e.id, "ack", o.morgan);
      expect(ackAgain.status).toBe(200);
      expect(entryOf(ackAgain).acked).toEqual(entryOf(ack).acked);
      const ask = (await asksOf(o.srv, o.morgan)).find((a) => a.id === e.askId);
      expect(ask?.page?.state).toBe("acked");

      const res = await act(o.srv, e.id, "resolve", o.morgan);
      expect(res.status).toBe(200);
      expect(entryOf(res).state).toBe("resolved");
      expect(entryOf(res).resolved?.by).toBe("Morgan");
      expect(entryOf(res).acked?.by).toBe("Morgan");
      expect(
        (await asksOf(o.srv, o.morgan)).some((a) => a.id === e.askId),
      ).toBe(false);
      const late = await act(o.srv, e.id, "ack", o.morgan);
      expect([late.status, errCode(late)]).toEqual([409, "already_resolved"]);
      await sleep(50);
      expect(heardAsk(ws, e.askId!)).toBe(true);
      expect(pagerEventCount(ws)).toBe(0);
    });

    it("a member it is not for sees nothing and acts on nothing, even with access to the source room", async () => {
      const o = await office();
      const sockets = {
        lee: await o.srv.connectWs(o.lee.rawSessionId!),
        mia: await o.srv.connectWs(o.mia.rawSessionId!),
      };
      const e = entryOf(await raise(o.srv, o.bot.token, { title: "x" }));
      for (const who of [o.lee, o.mia]) {
        expect(await listIds(o.srv, who, "?state=all")).toEqual([]);
        for (const [method, path] of [
          ["GET", `/api/pager/${e.id}`],
          ["POST", `/api/pager/${e.id}/ack`],
          ["POST", `/api/pager/${e.id}/resolve`],
        ]) {
          const r = await api(o.srv, path, { method, ...who });
          expect({ path, status: r.status }).toEqual({ path, status: 404 });
        }
      }
      const now = await api(o.srv, `/api/pager/${e.id}`, o.morgan);
      expect(entryOf(now).state).toBe("open");
      await sleep(50);
      expect([
        heardAsk(sockets.lee, e.askId!),
        heardAsk(sockets.mia, e.askId!),
      ]).toEqual([false, false]);
    });

    it("an office owner sees, acks and resolves another member's page", async () => {
      const o = await office();
      const leeBot = await spawnAgent(o.srv, "LeeBot", o.roomA, "Lee");
      const e = entryOf(await raise(o.srv, leeBot.token, { title: "x" }));
      expect(e.targetUserId).toBe(o.id("Lee"));
      expect(await listIds(o.srv, o.morgan)).toEqual([e.id]);
      expect(await listIds(o.srv, o.lee)).toEqual([e.id]);
      expect(await listIds(o.srv, o.mia)).toEqual([]);
      const ack = await act(o.srv, e.id, "ack", o.morgan);
      expect([ack.status, entryOf(ack).acked?.by]).toEqual([200, "Morgan"]);
      const res = await act(o.srv, e.id, "resolve", o.morgan);
      expect([res.status, entryOf(res).resolved?.by]).toEqual([200, "Morgan"]);
    });

    it("the source agent reads and withdraws its own page, even without access to its room; it never acks", async () => {
      const o = await office();
      // Mia's agent sits in room A, which Mia (and so her agent) cannot reach.
      const miaBot = await spawnAgent(o.srv, "MiaBot", o.roomA, "Mia");
      const e = entryOf(await raise(o.srv, miaBot.token, { title: "x" }));
      const self = { bearer: miaBot.token };
      expect((await api(o.srv, `/api/pager/${e.id}`, self)).status).toBe(200);
      expect(await listIds(o.srv, self)).toEqual([e.id]);
      expect((await act(o.srv, e.id, "ack", self)).status).toBe(404);
      const r = await act(o.srv, e.id, "resolve", self);
      expect(r.status).toBe(200);
      expect(entryOf(r).state).toBe("resolved");
      expect(entryOf(r).resolved?.by).toBe("MiaBot");
      expect(entryOf(r).acked).toBeUndefined();
      // Withdrawn: the agent's own history says so.
      const hist = await api(
        o.srv,
        `/api/agents/${miaBot.agent.id}/asks/history`,
        self,
      );
      expect(hist.status).toBe(200);
      const closed = (
        hist.body as { asks: { id: string; closed: { outcome: string } }[] }
      ).asks.find((a) => a.id === e.askId);
      expect(closed?.closed.outcome).toBe("withdrawn");
      const again = await act(o.srv, e.id, "resolve", self);
      expect([again.status, entryOf(again).resolved]).toEqual([
        200,
        entryOf(r).resolved,
      ]);
    });

    it("another agent, in the room or not, neither sees, acks nor resolves it", async () => {
      const o = await office();
      const peer = await spawnAgent(o.srv, "Peer", o.roomA, "Morgan");
      const e = entryOf(await raise(o.srv, o.bot.token, { title: "x" }));
      const asPeer = { bearer: peer.token };
      expect(await listIds(o.srv, asPeer, "?state=all")).toEqual([]);
      expect((await api(o.srv, `/api/pager/${e.id}`, asPeer)).status).toBe(404);
      for (const verb of ["ack", "resolve"] as const) {
        const r = await act(o.srv, e.id, verb, asPeer);
        expect({ verb, status: r.status }).toEqual({ verb, status: 404 });
      }
      expect(
        entryOf(await api(o.srv, `/api/pager/${e.id}`, o.morgan)).state,
      ).toBe("open");
    });
  });

  describe("the list", () => {
    it("defaults to open and acked, newest raise first; a re-raise moves a page up; state and roomId filter", async () => {
      const o = await office();
      const bBot = await spawnAgent(o.srv, "BBot", o.roomB, "Morgan");
      const raised = async (token: string, title: string, key?: string) => {
        const r = await raise(o.srv, token, { title, ...(key ? { key } : {}) });
        await sleep(2); // distinct lastRaisedAt
        return entryOf(r);
      };
      const p1 = await raised(o.bot.token, "one", "k1");
      const p2 = await raised(bBot.token, "two");
      const p3 = await raised(o.bot.token, "three");
      await act(o.srv, p3.id, "resolve", o.morgan);
      expect(await listIds(o.srv, o.morgan)).toEqual([p2.id, p1.id]);
      await raised(o.bot.token, "one again", "k1");
      expect(await listIds(o.srv, o.morgan)).toEqual([p1.id, p2.id]);
      await act(o.srv, p2.id, "ack", o.morgan);
      expect(await listIds(o.srv, o.morgan, "?state=acked")).toEqual([p2.id]);
      expect(await listIds(o.srv, o.morgan, "?state=open")).toEqual([p1.id]);
      // Open and acked pages first, then the slice of resolved ones.
      expect(await listIds(o.srv, o.morgan, "?state=all")).toEqual([
        p1.id,
        p2.id,
        p3.id,
      ]);
      expect(await listIds(o.srv, o.morgan, "?state=resolved")).toEqual([
        p3.id,
      ]);
      expect(await listIds(o.srv, o.morgan, `?roomId=${o.roomA}`)).toEqual([
        p1.id,
      ]);
      expect(
        await listIds(o.srv, o.morgan, `?state=all&roomId=${o.roomA}`),
      ).toEqual([p1.id, p3.id]);
      for (const q of ["?state=closed", "?roomId="]) {
        const bad = await api(o.srv, `/api/pager${q}`, o.morgan);
        expect({ q, status: bad.status }).toEqual({ q, status: 400 });
      }
    });

    it("a room filter the caller cannot access is 404", async () => {
      const o = await office();
      const r = await api(o.srv, `/api/pager?roomId=${o.roomA}`, o.mia);
      expect(r.status).toBe(404);
    });
  });

  describe("durability", () => {
    it("pages, their ids and states survive a cold restart, and the key still dedupes", async () => {
      const o = await office();
      const first = entryOf(
        await raise(o.srv, o.bot.token, { title: "x", key: "k", body: "b" }),
      );
      const acked = entryOf(await act(o.srv, first.id, "ack", o.morgan));
      const restarted = await o.srv.restart();
      server = restarted;
      const list = await api(restarted, "/api/pager", o.morgan);
      expect(list.body).toEqual([acked]);
      const token = mintAgentToken(o.bot.agent.id, o.id("Morgan"));
      const again = await raise(restarted, token, { title: "x", key: "k" });
      expect(again.status).toBe(200);
      expect(entryOf(again)).toMatchObject({
        id: first.id,
        askId: first.askId,
        state: "acked",
        raiseCount: 2,
      });
    });
  });
});

describe("closed pages", () => {
  // Raise one page per title and resolve each as `closer`, in order.
  async function raiseAndResolve(
    srv: TestServer,
    token: string,
    closer: Auth,
    titles: string[],
  ): Promise<string[]> {
    const out: string[] = [];
    for (const title of titles) {
      const id = entryOf(await raise(srv, token, { title })).id;
      const r = await act(srv, id, "resolve", closer);
      expect(r.status).toBe(200);
      out.push(id);
    }
    return out;
  }

  // Morgan's Bot in room A; Mia's MiaBot in room B.
  async function two() {
    const o = await office();
    const miaBot = await spawnAgent(o.srv, "MiaBot", o.roomB, "Mia");
    return { ...o, miaBot };
  }

  it("list newest close first, with limit and before; open and acked pages whole", async () => {
    const o = await two();
    const [p1, p2, p3, p4, p5] = await raiseAndResolve(
      o.srv,
      o.bot.token,
      o.morgan,
      ["1", "2", "3", "4", "5"],
    );
    const open = entryOf(await raise(o.srv, o.bot.token, { title: "open" }));
    const s = o.morgan;
    expect(await listIds(o.srv, s, "?state=resolved&limit=2")).toEqual([
      p5,
      p4,
    ]);
    expect(
      await listIds(o.srv, s, `?state=resolved&limit=2&before=${p4}`),
    ).toEqual([p3, p2]);
    expect(
      await listIds(o.srv, s, `?state=resolved&limit=2&before=${p2}`),
    ).toEqual([p1]);
    expect(await listIds(o.srv, s, "?state=all&limit=2")).toEqual([
      open.id,
      p5,
      p4,
    ]);
    expect(await listIds(o.srv, s, "")).toEqual([open.id]);
  });

  it("the default slice is 50", async () => {
    const o = await two();
    const ids = await raiseAndResolve(
      o.srv,
      o.bot.token,
      o.morgan,
      Array.from({ length: 51 }, (_, i) => `t${i}`),
    );
    const every = await listIds(o.srv, o.morgan, "?state=resolved&limit=200");
    expect(every).toEqual([...ids].reverse());
    expect(await listIds(o.srv, o.morgan, "?state=resolved")).toEqual(
      every.slice(0, 50),
    );
    expect(await listIds(o.srv, o.morgan, "?state=all")).toHaveLength(50);
  });

  it("a bad limit or before is 400, and an unknown, a hidden and an open cursor answer alike", async () => {
    const o = await two();
    const [hidden] = await raiseAndResolve(o.srv, o.bot.token, o.morgan, ["a"]);
    const [seen] = await raiseAndResolve(o.srv, o.miaBot.token, o.mia, ["b"]);
    const open = entryOf(await raise(o.srv, o.miaBot.token, { title: "open" }));
    for (const q of [
      "?state=resolved&limit=0",
      "?state=resolved&limit=201",
      "?state=resolved&limit=abc",
      "?state=resolved&limit=1.5",
      "?state=resolved&before=",
    ]) {
      const r = await api(o.srv, `/api/pager${q}`, o.morgan);
      expect({ q, status: r.status }).toEqual({ q, status: 400 });
    }
    expect(
      (await api(o.srv, "/api/pager?state=resolved&limit=200", o.morgan))
        .status,
    ).toBe(200);
    expect(await listIds(o.srv, o.mia, "?state=resolved&limit=5")).toEqual([
      seen,
    ]);
    const cursor = (id: string) =>
      api(o.srv, `/api/pager?state=resolved&before=${id}`, o.mia);
    const unknown = await cursor("ffffffffffffffff");
    expect(unknown.status).toBe(400);
    expect((await cursor(hidden)).body).toEqual(unknown.body);
    expect((await cursor(open.id)).body).toEqual(unknown.body);
  });

  it("visibility comes before the limit", async () => {
    const o = await two();
    const [q1] = await raiseAndResolve(o.srv, o.miaBot.token, o.mia, ["q1"]);
    // Newer pages Mia cannot see.
    await raiseAndResolve(o.srv, o.bot.token, o.morgan, ["x1", "x2", "x3"]);
    expect(await listIds(o.srv, o.mia, "?state=resolved&limit=2")).toEqual([
      q1,
    ]);
  });

  it("keep their GET, ack and resolve answers, for the members and the source agent they were for", async () => {
    const o = await two();
    const [id] = await raiseAndResolve(o.srv, o.bot.token, o.morgan, ["x"]);
    const got = await api(o.srv, `/api/pager/${id}`, o.morgan);
    expect(got.status).toBe(200);
    expect(entryOf(got).state).toBe("resolved");
    const again = await act(o.srv, id, "resolve", o.morgan);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(got.body);
    const ack = await act(o.srv, id, "ack", o.morgan);
    expect([ack.status, errCode(ack)]).toEqual([409, "already_resolved"]);
    const self = { bearer: o.bot.token };
    expect((await api(o.srv, `/api/pager/${id}`, self)).status).toBe(200);
    const bySource = await act(o.srv, id, "resolve", self);
    expect([bySource.status, bySource.body]).toEqual([200, got.body]);
    for (const who of [o.mia, o.lee, { bearer: o.miaBot.token }]) {
      for (const [method, path] of [
        ["GET", `/api/pager/${id}`],
        ["POST", `/api/pager/${id}/resolve`],
        ["POST", `/api/pager/${id}/ack`],
      ]) {
        const r = await api(o.srv, path, { method, ...who });
        expect({ path, status: r.status }).toEqual({ path, status: 404 });
      }
    }
  });

  it("a member it was for sees it only while they reach its agent's room", async () => {
    const o = await two();
    const [id] = await raiseAndResolve(o.srv, o.miaBot.token, o.mia, ["x"]);
    expect((await api(o.srv, `/api/pager/${id}`, o.mia)).status).toBe(200);
    expect(await listIds(o.srv, o.mia, "?state=resolved")).toEqual([id]);
    updateUserById(o.id("Mia"), { allowedRooms: [] });
    expect((await api(o.srv, `/api/pager/${id}`, o.mia)).status).toBe(404);
    expect(await listIds(o.srv, o.mia, "?state=resolved")).toEqual([]);
  });

  it("survive a cold restart", async () => {
    const o = await two();
    const [id] = await raiseAndResolve(o.srv, o.bot.token, o.morgan, ["x"]);
    const restarted = await o.srv.restart();
    server = restarted;
    expect(await listIds(restarted, o.morgan, "?state=resolved")).toEqual([id]);
    const got = await api(restarted, `/api/pager/${id}`, o.morgan);
    expect([got.status, entryOf(got).state]).toEqual([200, "resolved"]);
  });
});

describe("app pages", () => {
  // The app source of a page, asserting that it is one.
  function appSourceOf(e: PagerEntry): Extract<PagerSource, { kind: "app" }> {
    expect(e.source.kind).toBe("app");
    return e.source as Extract<PagerSource, { kind: "app" }>;
  }

  const appRaise = (srv: TestServer, token: string, body: unknown) =>
    api(srv, "/api/app/pager", { method: "POST", bearer: token, body });
  const appResolve = (srv: TestServer, token: string, body: unknown) =>
    api(srv, "/api/app/pager/resolve", { method: "POST", bearer: token, body });

  // Register an app through the real route and read its token from the
  // environment file the fake supervisor wrote.
  async function registerApp(
    srv: TestServer,
    agentToken: string,
    name: string,
  ): Promise<string> {
    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: agentToken,
      body: { name, command: "bun run serve.ts", cwd: srv.workDir },
    });
    expect(reg.status).toBe(201);
    const token = srv.appSupervisor.tokenFiles.get(name);
    if (!token) throw new Error(`no token file for ${name}`);
    return token;
  }

  // The office, with AppBot in room A (Morgan's) and its app "uptime".
  async function appOffice() {
    const o = await office();
    const appBot = await spawnAgent(o.srv, "AppBot", o.roomA, "Morgan");
    const appToken = await registerApp(o.srv, appBot.token, "uptime");
    return { ...o, appBot, appToken };
  }

  describe("raise", () => {
    it("source and target come from the app token and the registry; the page is an app ask for the owner", async () => {
      const o = await appOffice();
      const r = await appRaise(o.srv, o.appToken, {
        title: "AppBot is down",
        body: "no answer for 15 minutes",
        source: { kind: "agent", agentId: "spoof", name: "x", roomId: "x" },
        targetUserId: "spoof",
        state: "resolved",
      });
      expect(r.status).toBe(201);
      const e = entryOf(r);
      expect(e.source).toMatchObject({
        kind: "app",
        appName: "uptime",
        name: "uptime",
        roomId: o.roomA,
      });
      expect(e.targetUserId).toBe(o.id("Morgan"));
      expect(e.state).toBe("open");
      const ask = (await asksOf(o.srv, o.morgan)).find((a) => a.id === e.askId);
      expect(ask).toMatchObject({
        agentId: o.appBot.agent.id,
        app: { name: "uptime" },
        prompt: "AppBot is down\n\nno answer for 15 minutes",
        page: { pageId: e.id },
      });
    });

    it("the same key raises into the open page; bad fields are 400", async () => {
      const o = await appOffice();
      const first = await appRaise(o.srv, o.appToken, {
        title: "down",
        key: "k",
      });
      const again = await appRaise(o.srv, o.appToken, {
        title: "still",
        key: "k",
      });
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(entryOf(again).id).toBe(entryOf(first).id);
      expect(entryOf(again).raiseCount).toBe(2);
      const bad = await appRaise(o.srv, o.appToken, { title: "" });
      expect([bad.status, errCode(bad)]).toEqual([400, "invalid_request"]);
    });

    it("an app whose creator agent is gone still pages its owner's Discord, as an ask with no agent and no room", async () => {
      const o = await appOffice();
      const saved = await api(o.srv, "/api/users/Morgan/pager-settings", {
        method: "PATCH",
        ...o.morgan,
        body: {
          webhookUrl:
            "https://discord.com/api/webhooks/123456789012345678/AbC-xyz",
          discordUserId: "112233445566778899",
        },
      });
      expect(saved.status).toBe(200);
      await o.srv.agentManager.kill(o.appBot.agent.id);
      const r = await appRaise(o.srv, o.appToken, { title: "AppBot is gone" });
      expect(r.status).toBe(201);
      const e = entryOf(r);
      expect(e.source).toMatchObject({ kind: "app", roomId: null });
      expect(e.targetUserId).toBe(o.id("Morgan"));
      const ask = (await asksOf(o.srv, o.morgan)).find((a) => a.id === e.askId);
      expect(ask?.agentId).toBe("");
      const deadline = Date.now() + 3000;
      while (o.sent.length === 0 && Date.now() < deadline) await sleep(10);
      expect(o.sent).toHaveLength(1);
      expect(o.sent[0].embeds?.[0].title).toBe("AppBot is gone");
      expect(o.sent[0].embeds?.[0].footer?.text).toBe("uptime");
      const got = await api(o.srv, `/api/pager/${e.id}`, o.morgan);
      expect(entryOf(got).delivery).toMatchObject({
        state: "delivered",
        sends: 1,
      });
    });
  });

  describe("resolve", () => {
    it("resolves its own page by id and by key, recorded as the app", async () => {
      const o = await appOffice();
      const byId = entryOf(await appRaise(o.srv, o.appToken, { title: "a" }));
      const r1 = await appResolve(o.srv, o.appToken, { id: byId.id });
      expect(r1.status).toBe(200);
      expect(entryOf(r1).state).toBe("resolved");
      expect(entryOf(r1).resolved?.by).toBe("uptime");
      const again = await appResolve(o.srv, o.appToken, { id: byId.id });
      expect([again.status, again.body]).toEqual([200, r1.body]);

      const byKey = entryOf(
        await appRaise(o.srv, o.appToken, { title: "b", key: "k" }),
      );
      const r2 = await appResolve(o.srv, o.appToken, { key: "k" });
      expect(r2.status).toBe(200);
      expect(entryOf(r2).id).toBe(byKey.id);
      expect(entryOf(r2).state).toBe("resolved");
      // Nothing open with that key any more.
      expect((await appResolve(o.srv, o.appToken, { key: "k" })).status).toBe(
        404,
      );
    });

    it("needs exactly one of id or key", async () => {
      const o = await appOffice();
      for (const body of [{}, { id: "x", key: "k" }, { id: "" }, { key: 5 }]) {
        const r = await appResolve(o.srv, o.appToken, body);
        expect({ body, status: r.status }).toEqual({ body, status: 400 });
      }
    });

    it("resolves its own page after its creator agent is gone", async () => {
      const o = await appOffice();
      const page = entryOf(
        await appRaise(o.srv, o.appToken, { title: "a", key: "k" }),
      );
      expect(page.source.roomId).not.toBeNull();
      await o.srv.agentManager.kill(o.appBot.agent.id);
      const r = await appResolve(o.srv, o.appToken, { key: "k" });
      expect(r.status).toBe(200);
      expect(entryOf(r)).toMatchObject({ id: page.id, state: "resolved" });
    });

    it("cannot resolve an agent's page or another app's page, by id or by key", async () => {
      const o = await appOffice();
      const otherToken = await registerApp(o.srv, o.appBot.token, "other");
      const agentPage = entryOf(
        await raise(o.srv, o.appBot.token, { title: "agent", key: "k" }),
      );
      const otherPage = entryOf(
        await appRaise(o.srv, otherToken, { title: "o", key: "k" }),
      );
      const mine = entryOf(
        await appRaise(o.srv, o.appToken, { title: "mine", key: "m" }),
      );
      expect(appSourceOf(otherPage).appName).not.toBe(
        appSourceOf(mine).appName,
      );
      expect(agentPage.source.kind).toBe("agent");
      for (const body of [
        { id: agentPage.id },
        { id: otherPage.id },
        { key: "k" },
      ]) {
        const r = await appResolve(o.srv, o.appToken, body);
        expect({ body, status: r.status }).toEqual({ body, status: 404 });
      }
      for (const id of [agentPage.id, otherPage.id]) {
        const got = await api(o.srv, `/api/pager/${id}`, o.morgan);
        expect(entryOf(got).state).toBe("open");
      }
    });

    it("a later app with the same name never reaches the earlier one's pages", async () => {
      const o = await appOffice();
      const old = entryOf(
        await appRaise(o.srv, o.appToken, { title: "old", key: "k" }),
      );
      const del = await api(o.srv, "/api/apps/uptime", {
        method: "DELETE",
        bearer: o.appBot.token,
      });
      expect(del.status).toBe(204);
      const reborn = await registerApp(o.srv, o.appBot.token, "uptime");
      // The same key opens a new page instead of raising into the old one.
      const fresh = await appRaise(o.srv, reborn, { title: "new", key: "k" });
      expect(fresh.status).toBe(201);
      expect(entryOf(fresh).id).not.toBe(old.id);
      expect(appSourceOf(entryOf(fresh)).appName).toBe("uptime");
      expect((await appResolve(o.srv, reborn, { id: old.id })).status).toBe(
        404,
      );
      const byKey = await appResolve(o.srv, reborn, { key: "k" });
      expect(entryOf(byKey).id).toBe(entryOf(fresh).id);
      const oldNow = await api(o.srv, `/api/pager/${old.id}`, o.morgan);
      expect(entryOf(oldNow).state).toBe("open");
    });

    it("the app's target agent is not its source: it neither acks nor resolves the app's page", async () => {
      const o = await appOffice();
      const page = entryOf(
        await appRaise(o.srv, o.appToken, { title: "down" }),
      );
      const asTarget = { bearer: o.appBot.token };
      for (const verb of ["ack", "resolve"] as const) {
        const r = await act(o.srv, page.id, verb, asTarget);
        expect({ verb, status: r.status }).toEqual({ verb, status: 404 });
      }
      expect(
        entryOf(await api(o.srv, `/api/pager/${page.id}`, o.morgan)).state,
      ).toBe("open");
    });
  });

  describe("who reaches which route", () => {
    // An app has its live owner agent's reach (task c0204eb6), except the
    // agent raise route: it raises through /api/app/pager as itself.
    it("an app token never raises on the agent route, and reads pages only through a live owner agent", async () => {
      const o = await appOffice();
      const page = entryOf(await raise(o.srv, o.appBot.token, { title: "x" }));
      const agentRaise = () =>
        api(o.srv, "/api/pager", {
          method: "POST",
          bearer: o.appToken,
          body: { title: "x" },
        });
      expect((await agentRaise()).status).toBe(403);
      for (const path of ["/api/pager", `/api/pager/${page.id}`]) {
        const r = await api(o.srv, path, { bearer: o.appToken });
        expect({ path, status: r.status }).toEqual({ path, status: 200 });
      }
      await o.srv.agentManager.kill(o.appBot.agent.id);
      expect((await agentRaise()).status).toBe(403);
      for (const [method, path] of [
        ["GET", "/api/pager"],
        ["GET", `/api/pager/${page.id}`],
        ["POST", `/api/pager/${page.id}/ack`],
        ["POST", `/api/pager/${page.id}/resolve`],
      ]) {
        const r = await api(o.srv, path, {
          method,
          bearer: o.appToken,
          ...(method === "POST" ? { body: {} } : {}),
        });
        expect({ path, method, status: r.status }).toEqual({
          path,
          method,
          status: 403,
        });
      }
    });

    it("an agent token and a member session reach no app pager route", async () => {
      const o = await appOffice();
      for (const auth of [{ bearer: o.appBot.token }, o.morgan]) {
        const r1 = await api(o.srv, "/api/app/pager", {
          method: "POST",
          body: { title: "x" },
          ...auth,
        });
        const r2 = await api(o.srv, "/api/app/pager/resolve", {
          method: "POST",
          body: { key: "k" },
          ...auth,
        });
        expect([r1.status, r2.status]).toEqual([403, 403]);
      }
    });
  });

  describe("members", () => {
    // Kim owns the app (her agent in room A registered it). Lee reaches room
    // A, Mia only room B; Morgan is the office owner. Each has a socket.
    async function memberApp() {
      const o = await office();
      const kim = await o.srv.seedMember("Kim");
      updateUserById(o.id("Kim"), { allowedRooms: [o.roomA] });
      const kimBot = await spawnAgent(o.srv, "KimBot", o.roomA, "Kim");
      const kimToken = await registerApp(o.srv, kimBot.token, "kim-app");
      const who = {
        morgan: o.morgan,
        kim: { rawSessionId: kim.rawSessionId } as Auth,
        lee: o.lee,
        mia: o.mia,
      };
      const sockets: Record<string, TestSocket> = {};
      for (const [k, v] of Object.entries(who))
        sockets[k] = await o.srv.connectWs(v.rawSessionId!);
      return { ...o, kimBot, kimToken, who, sockets };
    }

    // Whether each member sees the page, in the list and by id alike.
    async function access(
      srv: TestServer,
      who: Record<string, Auth>,
      id: string,
    ) {
      const out: Record<string, boolean> = {};
      for (const [name, auth] of Object.entries(who)) {
        const listed = (await listIds(srv, auth, "?state=all")).includes(id);
        const got = await api(srv, `/api/pager/${id}`, auth);
        expect({ name, listed }).toEqual({ name, listed: got.status === 200 });
        out[name] = listed;
      }
      return out;
    }

    const heard = (
      sockets: Record<string, TestSocket>,
      askId: string,
    ): Record<string, boolean> =>
      Object.fromEntries(
        Object.entries(sockets).map(([k, ws]) => [k, heardAsk(ws, askId)]),
      );

    it("a page with a room: the app owner, and office owners as another member's; not the room", async () => {
      const o = await memberApp();
      const page = entryOf(
        await appRaise(o.srv, o.kimToken, { title: "down" }),
      );
      expect(page.source.roomId).toBe(o.roomA);
      expect(await access(o.srv, o.who, page.id)).toEqual({
        morgan: true,
        kim: true,
        lee: false,
        mia: false,
      });
      for (const m of [o.who.lee, o.who.mia])
        expect((await act(o.srv, page.id, "ack", m)).status).toBe(404);
      const kimAck = await act(o.srv, page.id, "ack", o.who.kim);
      expect([kimAck.status, entryOf(kimAck).acked?.by]).toEqual([200, "Kim"]);
      await sleep(50);
      expect(heard(o.sockets, page.askId!)).toEqual({
        morgan: true,
        kim: true,
        lee: false,
        mia: false,
      });
    });

    it("a page with no room: the app owner and office owners only; a room filter leaves it out", async () => {
      const o = await memberApp();
      await o.srv.agentManager.kill(o.kimBot.agent.id);
      const page = entryOf(
        await appRaise(o.srv, o.kimToken, { title: "down" }),
      );
      expect(page.source.roomId).toBeNull();
      expect(await access(o.srv, o.who, page.id)).toEqual({
        morgan: true,
        kim: true,
        lee: false,
        mia: false,
      });
      for (const m of [o.who.lee, o.who.mia])
        for (const verb of ["ack", "resolve"] as const) {
          const r = await act(o.srv, page.id, verb, m);
          expect({ verb, status: r.status }).toEqual({ verb, status: 404 });
        }
      expect((await act(o.srv, page.id, "ack", o.who.kim)).status).toBe(200);
      const inA = await listIds(
        o.srv,
        o.morgan,
        `?state=all&roomId=${o.roomA}`,
      );
      expect(inA).not.toContain(page.id);
      const res = await act(o.srv, page.id, "resolve", o.who.morgan);
      expect([res.status, entryOf(res).resolved?.by]).toEqual([200, "Morgan"]);
      await sleep(50);
      expect(heard(o.sockets, page.askId!)).toEqual({
        morgan: true,
        kim: true,
        lee: false,
        mia: false,
      });
    });

    it("a page's room is its creator agent's room now", async () => {
      const o = await memberApp();
      const page = entryOf(
        await appRaise(o.srv, o.kimToken, { title: "down", key: "k" }),
      );
      expect(page.source.roomId).toBe(o.roomA);
      updateUserById(o.id("Kim"), { allowedRooms: [o.roomA, o.roomB] });
      expect(o.srv.agentManager.moveAgent(o.kimBot.agent.id, o.roomB)).toBe(
        true,
      );
      const again = entryOf(
        await appRaise(o.srv, o.kimToken, { title: "down", key: "k" }),
      );
      expect(again.id).toBe(page.id);
      expect(again.source.roomId).toBe(o.roomB);
      expect(await listIds(o.srv, o.morgan, `?roomId=${o.roomB}`)).toEqual([
        page.id,
      ]);
      expect(await listIds(o.srv, o.morgan, `?roomId=${o.roomA}`)).toEqual([]);
    });
  });

  describe("durability", () => {
    it("after a cold restart the same app token raises into and resolves its page", async () => {
      const o = await appOffice();
      const first = entryOf(
        await appRaise(o.srv, o.appToken, { title: "down", key: "k" }),
      );
      const restarted = await o.srv.restart();
      server = restarted;
      const again = await appRaise(restarted, o.appToken, {
        title: "down",
        key: "k",
      });
      expect([again.status, entryOf(again).id]).toEqual([200, first.id]);
      const r = await appResolve(restarted, o.appToken, { key: "k" });
      expect([r.status, entryOf(r).id]).toEqual([200, first.id]);
      expect(await listIds(restarted, o.morgan, "?state=resolved")).toEqual([
        first.id,
      ]);
    });
  });
});

describe("app pager handler: an unowned app", () => {
  // An unowned app cannot be registered through the route, so this case runs
  // at the handler seam.
  it("has nobody to page: 409, and no ask opens", async () => {
    const asks = createAskStore({
      persistence: {
        load: () => ({ kind: "missing" }),
        save: () => {},
        quarantine: () => true,
      },
    });
    const h = pagerHandlers({
      asks,
      history: {
        getByPageId: () => null,
        listPaged: () => ({ ok: true, items: [] }),
        members: () => [],
      },
      audience: {
        isOfficeOwner: () => false,
        agentRoomId: () => "r1",
        canSeeRoom: () => true,
        roomHidden: () => false,
        roomMemberIds: () => [],
      },
      compat: {
        agent: () => ({ name: "Bot", roomId: "r1" }),
        app: () => ({ registrationGen: 1, roomId: "r1" }),
        memberName: () => null,
      },
      accessibleRoomIds: () => new Set(["r1"]),
      agentSource: () => ({ managerUserId: "u1" }),
      appSource: () => ({
        createdAt: 7,
        ownerUserId: null,
        targetAgentId: "a1",
      }),
    });
    const ctx: RouteHandlerContext = {
      identity: {
        scope: "app",
        userId: null,
        appName: "legacy",
        role: "member",
        capabilities: ["app:message", "pager:raise"],
      },
      params: {},
      body: { title: "down" },
      rawBody: JSON.stringify({ title: "down" }),
      query: new URLSearchParams(),
      req: new Request("http://localhost/"),
    };
    expect(await h["pager.appRaise"](ctx)).toMatchObject({
      kind: "error",
      status: 409,
      code: "no_owner",
    });
    expect(asks.listAll()).toEqual([]);
  });
});

describe("paged asks from the other routes", () => {
  it("an agent's ask with page is a page of its member, named by the page id on the ask", async () => {
    const o = await office();
    const made = await api(o.srv, `/api/agents/${o.bot.agent.id}/asks`, {
      method: "POST",
      bearer: o.bot.token,
      body: { text: "Restart the box?", page: true },
    });
    expect(made.status).toBe(201);
    const ask = made.body as AskMemberWire;
    const pageId = ask.page?.pageId ?? "";
    expect(pageId).toMatch(/^[0-9a-f]{16}$/);
    expect(await listIds(o.srv, o.morgan)).toEqual([pageId]);
    const got = entryOf(await api(o.srv, `/api/pager/${pageId}`, o.morgan));
    expect(got).toMatchObject({
      askId: ask.id,
      title: "Restart the box?",
      targetUserId: o.id("Morgan"),
      state: "open",
    });
  });

  it("an office page is its member's page from the feature; they ack and resolve it", async () => {
    const o = await office();
    managers.officePagers.whatsapp.raise(
      o.id("Lee"),
      `whatsapp:${o.id("Lee")}:dead`,
      "WhatsApp stopped",
      "The bridge exited.",
    );
    const [id] = await listIds(o.srv, o.lee);
    const e = entryOf(await api(o.srv, `/api/pager/${id}`, o.lee));
    expect(e.source).toEqual({
      kind: "office",
      feature: "whatsapp",
      name: expect.any(String),
      roomId: null,
    });
    expect([e.title, e.body]).toEqual([
      "WhatsApp stopped",
      "The bridge exited.",
    ]);
    expect(await listIds(o.srv, o.morgan, "?state=all")).toEqual([]);
    expect((await act(o.srv, id, "ack", o.lee)).status).toBe(200);
    const res = await act(o.srv, id, "resolve", o.lee);
    expect([res.status, entryOf(res).state]).toEqual([200, "resolved"]);
  });
});
