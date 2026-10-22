// The pager routes (server/routes/handlers/pager.ts): agent and app pages,
// visibility, ack and resolve, the resolved slices, and durability.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo, PagerEntry, PagerSource } from "../../shared/types.ts";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pagerHandlers } from "../routes/handlers/pager.ts";
import type { RouteHandlerContext } from "../routes/executor.ts";
import { createPagerStore } from "../pager-store.ts";

describe("agent pages", () => {
  // Pager routes (opIds pager.*) through the real route table and server.
  //
  // Pins: source and target come from the agent's token and agent record, never
  // the body; key dedupe over HTTP; room-access visibility for list, get, ack,
  // resolve and the per-socket event; the source resolves its own page even
  // without room access; pages survive a cold restart.
  //
  // Seam: startTestServer(). Zero LLM.

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

  // One office: owner Morgan; member Mia with access to room B only; Bot in room A
  // managed by Morgan.
  async function office() {
    const srv = await startTestServer();
    server = srv;
    const morgan = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
    const bot = await spawnAgent(srv, "Bot", roomA, "Morgan");
    return { srv, morgan, mia, roomA, roomB, bot };
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
      expect(e.targetUserId).toBe(getUserByName("Morgan")!.id);
      expect(e.state).toBe("open");
      expect(e.delivery.state).toBe("not_delivered");
    });

    it("the target is the agent's recorded manager, not the token's user", async () => {
      const { srv, roomA } = await office();
      const { agent } = await spawnAgent(srv, "Bot2", roomA, "Morgan");
      const token = mintAgentToken(agent.id, getUserByName("Mia")!.id);
      const r = await api(srv, "/api/pager", {
        method: "POST",
        bearer: token,
        body: { title: "x" },
      });
      expect(r.status).toBe(201);
      expect((r.body as PagerEntry).targetUserId).toBe(
        getUserByName("Morgan")!.id,
      );
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
      const { srv, morgan, roomA, bot } = await office();
      const asMorgan = await api(srv, "/api/pager", {
        method: "POST",
        rawSessionId: morgan.rawSessionId,
        body: { title: "x" },
      });
      expect(asMorgan.status).toBe(403);
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
      const { srv, morgan, bot } = await office();
      const morganWs = await srv.connectWs(morgan.rawSessionId);
      const e = (
        await api(srv, "/api/pager", {
          method: "POST",
          bearer: bot.token,
          body: { title: "x" },
        })
      ).body as PagerEntry;
      const ack = await api(srv, `/api/pager/${e.id}/ack`, {
        method: "POST",
        rawSessionId: morgan.rawSessionId,
      });
      expect(ack.status).toBe(200);
      expect((ack.body as PagerEntry).acked?.by).toBe("Morgan");
      const res = await api(srv, `/api/pager/${e.id}/resolve`, {
        method: "POST",
        rawSessionId: morgan.rawSessionId,
      });
      expect(res.status).toBe(200);
      expect((res.body as PagerEntry).state).toBe("resolved");
      const again = await api(srv, `/api/pager/${e.id}/ack`, {
        method: "POST",
        rawSessionId: morgan.rawSessionId,
      });
      expect(again.status).toBe(409);
      expect(errCode(again)).toBe("already_resolved");
      await sleep(50);
      // The second "open" and the second "resolved" are delivery attempts (the
      // page, then the resolved message): the manager has no webhook.
      const events = pagerEvents(morganWs);
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
      const { srv, morgan, roomA, bot } = await office();
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
        rawSessionId: morgan.rawSessionId,
      });
      expect((after.body as PagerEntry).state).toBe("open");
    });

    it("another agent with access to the room can ack the page", async () => {
      const { srv, roomA, bot } = await office();
      const peer = await spawnAgent(srv, "Peer", roomA, "Morgan");
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
      const { srv, morgan, roomA, roomB, bot } = await office();
      const bBot = await spawnAgent(srv, "BBot", roomB, "Morgan");
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
        rawSessionId: morgan.rawSessionId,
      });
      const ids = async (q: string) => {
        const r = await api(srv, `/api/pager${q}`, {
          rawSessionId: morgan.rawSessionId,
        });
        expect(r.status).toBe(200);
        return (r.body as PagerEntry[]).map((e) => e.id);
      };
      expect(await ids("")).toEqual([p2.id, p1.id]);
      // Open and acked pages first, then the slice of resolved ones.
      expect(await ids("?state=all")).toEqual([p2.id, p1.id, p3.id]);
      expect(await ids("?state=resolved")).toEqual([p3.id]);
      expect(await ids(`?roomId=${roomA}`)).toEqual([p1.id]);
      const bad = await api(srv, "/api/pager?state=closed", {
        rawSessionId: morgan.rawSessionId,
      });
      expect(bad.status).toBe(400);
      const empty = await api(srv, "/api/pager?roomId=", {
        rawSessionId: morgan.rawSessionId,
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
      const { srv, morgan, bot } = await office();
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
          rawSessionId: morgan.rawSessionId,
        })
      ).body as PagerEntry;
      const restarted = await srv.restart();
      server = restarted;
      const list = await api(restarted, "/api/pager", {
        rawSessionId: morgan.rawSessionId,
      });
      expect(list.body).toEqual([acked]);
      const token = mintAgentToken(bot.agent.id, getUserByName("Morgan")!.id);
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
});

describe("resolved slices", () => {
  // Resolved pages through the real routes (task af346c0c): GET /api/pager
  // returns open and acked pages whole and resolved pages one slice at a time
  // (limit, before), visibility before the limit; an archived page keeps its
  // GET, ack and resolve answers.
  //
  // Seam: startTestServer(). The members have no Discord webhook, so a resolve
  // records its "resolved" message as not sent at once and the page moves to
  // STATE_ROOT/pager-resolved.jsonl. Zero LLM.

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
      rawSessionId?: string;
      bearer?: string;
      body?: unknown;
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

  async function spawnAgent(srv: TestServer, name: string, roomId: string) {
    const userId = getUserByName("Morgan")!.id;
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
      "Morgan",
      "claude",
      undefined,
      userId,
    );
    if (!agent) throw new Error(`spawn ${name} returned null`);
    return { agent, token: mintAgentToken(agent.id, userId) };
  }

  // Owner Morgan; member Mia with room B only; Bot in room A, BBot in room B.
  async function office() {
    const srv = await startTestServer();
    server = srv;
    const morgan = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
    const bot = await spawnAgent(srv, "Bot", roomA);
    const bBot = await spawnAgent(srv, "BBot", roomB);
    return { srv, morgan, mia, bot, bBot };
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
    morganSession: string,
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
        rawSessionId: morganSession,
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
      const { srv, morgan, bot } = await office();
      const [p1, p2, p3, p4, p5] = await raiseAndResolve(
        srv,
        bot.token,
        morgan.rawSessionId,
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

      const s = morgan.rawSessionId;
      expect(await listIds(srv, s, "?state=resolved&limit=2")).toEqual([
        p5,
        p4,
      ]);
      expect(
        await listIds(srv, s, `?state=resolved&limit=2&before=${p4}`),
      ).toEqual([p3, p2]);
      expect(
        await listIds(srv, s, `?state=resolved&limit=2&before=${p2}`),
      ).toEqual([p1]);
      expect(await listIds(srv, s, "?state=all&limit=2")).toEqual([
        open.id,
        p5,
        p4,
      ]);
      expect(await listIds(srv, s, "")).toEqual([open.id]);
    });

    it("the default slice is 50", async () => {
      const { srv, morgan, bot } = await office();
      // One resolve per raise keeps the source under its open-page cap; the
      // order is read back from a wide slice, so no wait per page is needed.
      const ids: string[] = [];
      for (let i = 0; i < 51; i++) {
        const raised = await api(srv, "/api/pager", {
          method: "POST",
          bearer: bot.token,
          body: { title: `t${i}` },
        });
        const id = (raised.body as PagerEntry).id;
        await api(srv, `/api/pager/${id}/resolve`, {
          method: "POST",
          rawSessionId: morgan.rawSessionId,
        });
        ids.push(id);
      }
      const deadline = Date.now() + 5000;
      while (archivedIds(srv).length < ids.length) {
        if (Date.now() > deadline) throw new Error("pages never archived");
        await new Promise((r) => setTimeout(r, 5));
      }
      const every = await listIds(
        srv,
        morgan.rawSessionId,
        "?state=resolved&limit=200",
      );
      expect([...every].sort()).toEqual([...ids].sort());
      const got = await listIds(srv, morgan.rawSessionId, "?state=resolved");
      expect(got).toEqual(every.slice(0, 50));
      const all = await listIds(srv, morgan.rawSessionId, "?state=all");
      expect(all).toHaveLength(50);
    });

    it("a bad limit or before is 400, and an unknown and an invisible cursor answer alike", async () => {
      const { srv, morgan, mia, bot, bBot } = await office();
      const [hidden] = await raiseAndResolve(
        srv,
        bot.token,
        morgan.rawSessionId,
        ["a"],
      );
      const [seen] = await raiseAndResolve(
        srv,
        bBot.token,
        morgan.rawSessionId,
        ["b"],
      );
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
        const r = await api(srv, `/api/pager${q}`, {
          rawSessionId: morgan.rawSessionId,
        });
        expect(r.status).toBe(400);
      }
      expect(
        (
          await api(srv, "/api/pager?state=resolved&limit=200", {
            rawSessionId: morgan.rawSessionId,
          })
        ).status,
      ).toBe(200);
      // Mia sees room B only: the room A page is not in her list, and as a
      // cursor it is the same 400 as an id that does not exist.
      expect(
        await listIds(srv, mia.rawSessionId, "?state=resolved&limit=1"),
      ).toEqual([seen]);
      const invisible = await api(
        srv,
        `/api/pager?state=resolved&before=${hidden}`,
        { rawSessionId: mia.rawSessionId },
      );
      const unknown = await api(
        srv,
        "/api/pager?state=resolved&before=ffffffff",
        {
          rawSessionId: mia.rawSessionId,
        },
      );
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
      const { srv, morgan, mia, bot, bBot } = await office();
      const [q1] = await raiseAndResolve(srv, bBot.token, morgan.rawSessionId, [
        "q1",
      ]);
      // Newer pages Mia cannot see.
      await raiseAndResolve(srv, bot.token, morgan.rawSessionId, [
        "x1",
        "x2",
        "x3",
      ]);
      expect(
        await listIds(srv, mia.rawSessionId, "?state=resolved&limit=2"),
      ).toEqual([q1]);
    });
  });

  describe("pager REST: archived pages", () => {
    it("keep their GET, ack and resolve answers", async () => {
      const { srv, morgan, mia, bot } = await office();
      const [id] = await raiseAndResolve(srv, bot.token, morgan.rawSessionId, [
        "x",
      ]);
      const s = morgan.rawSessionId;
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
      for (const path of [
        `/api/pager/${id}`,
        `/api/pager/${id}/resolve`,
        `/api/pager/${id}/ack`,
      ]) {
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
      const { srv, morgan, bot } = await office();
      const [id] = await raiseAndResolve(srv, bot.token, morgan.rawSessionId, [
        "x",
      ]);
      const restarted = await srv.restart();
      server = restarted;
      expect(
        await listIds(restarted, morgan.rawSessionId, "?state=resolved"),
      ).toEqual([id]);
      const got = await api(restarted, `/api/pager/${id}`, {
        rawSessionId: morgan.rawSessionId,
      });
      expect(got.status).toBe(200);
    });
  });
});

describe("app pages", () => {
  // App pager routes (pager.appRaise, pager.appResolve) through the real route
  // table and server.
  //
  // Pins: source and target come from the app token and the registry, never the
  // body; key dedupe; an app whose creator agent is gone still pages, with no
  // room; an app resolves only its own pages (by id or by key), never an
  // agent's, another app's or an earlier registration's of the same name, and
  // whatever its creator's state now; an app token reaches no agent pager route
  // and an agent token no app route; the page reaches the owner's Discord stub;
  // access follows the stored room plus the app owner and office owners, the
  // same for the routes and the socket event, and a null room leaves the page to
  // those two; the source identity survives a cold restart.
  //
  // Seam: startTestServer() with a stub pagerFetch; the app supervisor is the
  // harness fake. An unowned app cannot be registered through the route, so that
  // case runs at the handler seam. Zero LLM, no Discord.

  const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/AbC-xyz";
  const DISCORD_ID = "112233445566778899";

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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // The app source of a page, asserting that it is one.
  function appSourceOf(e: PagerEntry): Extract<PagerSource, { kind: "app" }> {
    expect(e.source.kind).toBe("app");
    return e.source as Extract<PagerSource, { kind: "app" }>;
  }

  const appRaise = (srv: TestServer, token: string, body: unknown) =>
    api(srv, "/api/app/pager", { method: "POST", bearer: token, body });
  const appResolve = (srv: TestServer, token: string, body: unknown) =>
    api(srv, "/api/app/pager/resolve", { method: "POST", bearer: token, body });

  const pagerEvents = (s: TestSocket): PagerEntry[] =>
    s.messages
      .filter((m) => (m as { type?: string }).type === "pager_upserted")
      .map((m) => (m as { entry: PagerEntry }).entry);

  async function spawnAgent(
    srv: TestServer,
    name: string,
    roomId: string,
    managerName = "Morgan",
  ): Promise<{ agent: AgentInfo; token: string }> {
    const userId = getUserByName(managerName)!.id;
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
      managerName,
      "claude",
      undefined,
      userId,
    );
    if (!agent) throw new Error(`spawn ${name} returned null`);
    return { agent, token: mintAgentToken(agent.id, userId) };
  }

  // Register an app through the real route and read its token from the
  // environment file the fake supervisor wrote, where the running app reads it.
  async function registerApp(
    srv: TestServer,
    agentToken: string,
    name: string,
  ): Promise<string> {
    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: agentToken,
      body: { name, command: "bun run serve.ts", cwd: srv.stateRoot },
    });
    expect(reg.status).toBe(201);
    const token = srv.appSupervisor.tokenFiles.get(name);
    if (!token) throw new Error(`no token file for ${name}`);
    return token;
  }

  async function saveWebhook(
    srv: TestServer,
    who: { username: string; rawSessionId: string },
  ) {
    const saved = await api(srv, `/api/users/${who.username}/pager-settings`, {
      method: "PATCH",
      rawSessionId: who.rawSessionId,
      body: { webhookUrl: WEBHOOK, discordUserId: DISCORD_ID },
    });
    expect(saved.status).toBe(200);
  }

  // One office: owner Morgan; member Mia with access to
  // room B only; AppBot in room A, managed by Morgan, registered app "uptime".
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
    const mia = await srv.seedMember("Mia");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
    const bot = await spawnAgent(srv, "AppBot", roomA);
    const appToken = await registerApp(srv, bot.token, "uptime");
    return { srv, morgan, mia, roomA, roomB, bot, appToken, sent };
  }

  describe("app pager REST: raise", () => {
    it("source and target come from the app token and the registry, not the body", async () => {
      const { srv, roomA, appToken } = await office();
      const r = await appRaise(srv, appToken, {
        title: "AppBot is down",
        body: "no answer for 15 minutes",
        source: { kind: "agent", agentId: "spoof", name: "x", roomId: "x" },
        targetUserId: "spoof",
        state: "resolved",
      });
      expect(r.status).toBe(201);
      const e = r.body as PagerEntry;
      expect(e.source).toMatchObject({
        kind: "app",
        appName: "uptime",
        name: "uptime",
        roomId: roomA,
      });
      expect(e.targetUserId).toBe(getUserByName("Morgan")!.id);
      expect(e.state).toBe("open");
    });

    it("the same key dedupes into the open page; bad fields are 400", async () => {
      const { srv, appToken } = await office();
      const first = await appRaise(srv, appToken, { title: "down", key: "k" });
      const again = await appRaise(srv, appToken, { title: "still", key: "k" });
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect((again.body as PagerEntry).id).toBe((first.body as PagerEntry).id);
      expect((again.body as PagerEntry).raiseCount).toBe(2);
      const bad = await appRaise(srv, appToken, { title: "" });
      expect(bad.status).toBe(400);
      expect(errCode(bad)).toBe("invalid_request");
    });

    it("an app whose creator agent is gone still pages its owner's Discord, with no room", async () => {
      const { srv, morgan, bot, appToken, sent } = await office();
      await saveWebhook(srv, morgan);
      await srv.agentManager.kill(bot.agent.id);
      const r = await appRaise(srv, appToken, { title: "AppBot is gone" });
      expect(r.status).toBe(201);
      const e = r.body as PagerEntry;
      expect(e.source).toMatchObject({ kind: "app", roomId: null });
      expect(e.targetUserId).toBe(getUserByName("Morgan")!.id);
      await sleep(50);
      expect(sent).toHaveLength(1);
      expect(sent[0].embeds?.[0].title).toBe("AppBot is gone");
      expect(sent[0].embeds?.[0].footer?.text).toBe("uptime");
      const got = await api(srv, `/api/pager/${e.id}`, {
        rawSessionId: morgan.rawSessionId,
      });
      expect((got.body as PagerEntry).delivery).toMatchObject({
        state: "delivered",
        sends: 1,
      });
    });
  });

  describe("app pager REST: resolve", () => {
    it("resolves its own page by id and by key, recorded as the app", async () => {
      const { srv, appToken } = await office();
      const byId = (await appRaise(srv, appToken, { title: "a" }))
        .body as PagerEntry;
      const r1 = await appResolve(srv, appToken, { id: byId.id });
      expect(r1.status).toBe(200);
      expect((r1.body as PagerEntry).state).toBe("resolved");
      expect((r1.body as PagerEntry).resolved?.by).toBe("uptime");
      const again = await appResolve(srv, appToken, { id: byId.id });
      expect(again.status).toBe(200);

      const byKey = (await appRaise(srv, appToken, { title: "b", key: "k" }))
        .body as PagerEntry;
      const r2 = await appResolve(srv, appToken, { key: "k" });
      expect(r2.status).toBe(200);
      expect((r2.body as PagerEntry).id).toBe(byKey.id);
      expect((r2.body as PagerEntry).state).toBe("resolved");
      // Nothing open with that key any more.
      expect((await appResolve(srv, appToken, { key: "k" })).status).toBe(404);
    });

    it("needs exactly one of id or key", async () => {
      const { srv, appToken } = await office();
      for (const body of [{}, { id: "x", key: "k" }, { id: "" }, { key: 5 }]) {
        const r = await appResolve(srv, appToken, body);
        expect({ body, status: r.status }).toEqual({ body, status: 400 });
      }
    });

    it("resolves its own page after its creator agent is gone", async () => {
      const { srv, bot, appToken } = await office();
      const page = (await appRaise(srv, appToken, { title: "a", key: "k" }))
        .body as PagerEntry;
      expect(page.source.roomId).not.toBeNull();
      await srv.agentManager.kill(bot.agent.id);
      const r = await appResolve(srv, appToken, { key: "k" });
      expect(r.status).toBe(200);
      expect((r.body as PagerEntry).id).toBe(page.id);
      expect((r.body as PagerEntry).state).toBe("resolved");
    });

    it("cannot resolve an agent's page or another app's page, by id or by key", async () => {
      const { srv, bot, appToken } = await office();
      const otherToken = await registerApp(srv, bot.token, "other");
      const agentPage = (
        await api(srv, "/api/pager", {
          method: "POST",
          bearer: bot.token,
          body: { title: "agent", key: "k" },
        })
      ).body as PagerEntry;
      const otherPage = (
        await appRaise(srv, otherToken, { title: "o", key: "k" })
      ).body as PagerEntry;
      // The other app differs from the caller by name only: the same
      // registration generation, so only the name check can refuse it.
      const mine = (await appRaise(srv, appToken, { title: "mine", key: "m" }))
        .body as PagerEntry;
      expect(appSourceOf(otherPage).appName).not.toBe(
        appSourceOf(mine).appName,
      );
      expect(appSourceOf(otherPage).registrationGen).toBe(
        appSourceOf(mine).registrationGen,
      );
      expect(agentPage.source.kind).toBe("agent");
      for (const body of [
        { id: agentPage.id },
        { id: otherPage.id },
        { key: "k" },
      ]) {
        const r = await appResolve(srv, appToken, body);
        expect({ body, status: r.status }).toEqual({ body, status: 404 });
      }
      for (const id of [agentPage.id, otherPage.id]) {
        const got = await api(srv, `/api/pager/${id}`, { bearer: bot.token });
        expect((got.body as PagerEntry).state).toBe("open");
      }
    });

    it("a later app with the same name never reaches the earlier one's pages", async () => {
      const { srv, bot, appToken } = await office();
      const old = (await appRaise(srv, appToken, { title: "old", key: "k" }))
        .body as PagerEntry;
      const del = await api(srv, "/api/apps/uptime", {
        method: "DELETE",
        bearer: bot.token,
      });
      expect(del.status).toBe(204);
      const reborn = await registerApp(srv, bot.token, "uptime");
      // The same key creates a new page instead of deduping into the old one.
      const fresh = await appRaise(srv, reborn, { title: "new", key: "k" });
      expect(fresh.status).toBe(201);
      expect((fresh.body as PagerEntry).id).not.toBe(old.id);
      // Same name, another registration: only the generation tells them apart.
      const oldSource = appSourceOf(old);
      const freshSource = appSourceOf(fresh.body as PagerEntry);
      expect(freshSource.appName).toBe(oldSource.appName);
      expect(freshSource.registrationGen).not.toBe(oldSource.registrationGen);
      expect((await appResolve(srv, reborn, { id: old.id })).status).toBe(404);
      const byKey = await appResolve(srv, reborn, { key: "k" });
      expect((byKey.body as PagerEntry).id).toBe((fresh.body as PagerEntry).id);
      const oldNow = await api(srv, `/api/pager/${old.id}`, {
        bearer: bot.token,
      });
      expect((oldNow.body as PagerEntry).state).toBe("open");
    });
  });

  describe("app pager REST: who reaches which route", () => {
    // An app has its live owner agent's reach (task c0204eb6), except the agent
    // raise route: it raises through /api/app/pager as itself.
    it("an app token never raises on the agent route, and reads pages only through a live owner agent", async () => {
      const { srv, bot, appToken } = await office();
      const page = (
        await api(srv, "/api/pager", {
          method: "POST",
          bearer: bot.token,
          body: { title: "x" },
        })
      ).body as PagerEntry;
      const raise = () =>
        api(srv, "/api/pager", {
          method: "POST",
          bearer: appToken,
          body: { title: "x" },
        });
      const reads: string[] = ["/api/pager", `/api/pager/${page.id}`];
      expect((await raise()).status).toBe(403);
      for (const path of reads) {
        const r = await api(srv, path, { method: "GET", bearer: appToken });
        expect({ path, status: r.status }).toEqual({ path, status: 200 });
      }

      await srv.agentManager.kill(bot.agent.id);
      expect(srv.agentManager.getAgent(bot.agent.id)).toBeUndefined();
      const calls: Array<[string, string]> = [
        ["GET", "/api/pager"],
        ["GET", `/api/pager/${page.id}`],
        ["POST", `/api/pager/${page.id}/ack`],
        ["POST", `/api/pager/${page.id}/resolve`],
      ];
      expect((await raise()).status).toBe(403);
      for (const [method, path] of calls) {
        const r = await api(srv, path, {
          method,
          bearer: appToken,
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
      const { srv, morgan, bot } = await office();
      for (const auth of [
        { bearer: bot.token },
        { rawSessionId: morgan.rawSessionId },
      ]) {
        const raise = await api(srv, "/api/app/pager", {
          method: "POST",
          body: { title: "x" },
          ...auth,
        });
        const resolve = await api(srv, "/api/app/pager/resolve", {
          method: "POST",
          body: { key: "k" },
          ...auth,
        });
        expect([raise.status, resolve.status]).toEqual([403, 403]);
      }
    });
  });

  describe("app pager REST: members", () => {
    // Kim owns the app (her agent in room A registered it). Lee can access room
    // A, Mia only room B, Morgan is the office owner. Every one has a socket.
    async function memberApp() {
      const base = await office();
      const { srv, roomA, roomB } = base;
      const kim = await srv.seedMember("Kim");
      const lee = await srv.seedMember("Lee");
      updateUserById(getUserByName("Kim")!.id, { allowedRooms: [roomA] });
      updateUserById(getUserByName("Lee")!.id, { allowedRooms: [roomA] });
      const kimBot = await spawnAgent(srv, "KimBot", roomA, "Kim");
      const kimToken = await registerApp(srv, kimBot.token, "kim-app");
      const who = { morgan: base.morgan, kim, lee, mia: base.mia };
      const sockets = Object.fromEntries(
        await Promise.all(
          Object.entries(who).map(
            async ([k, v]) => [k, await srv.connectWs(v.rawSessionId)] as const,
          ),
        ),
      ) as Record<keyof typeof who, TestSocket>;
      return { ...base, roomB, kimBot, kimToken, who, sockets };
    }

    // What each member can do with the page: see it in the list and by id.
    async function access(
      srv: TestServer,
      who: Record<string, { rawSessionId: string }>,
      id: string,
    ) {
      const out: Record<string, boolean> = {};
      for (const [name, m] of Object.entries(who)) {
        const list = await api(srv, "/api/pager", {
          rawSessionId: m.rawSessionId,
        });
        const listed = (list.body as PagerEntry[]).some((e) => e.id === id);
        const got = await api(srv, `/api/pager/${id}`, {
          rawSessionId: m.rawSessionId,
        });
        expect({ name, listed }).toEqual({ name, listed: got.status === 200 });
        out[name] = listed;
      }
      return out;
    }

    it("a page with a room: room access, the app owner and office owners", async () => {
      const { srv, who, sockets, kimToken } = await memberApp();
      const page = (await appRaise(srv, kimToken, { title: "down" }))
        .body as PagerEntry;
      expect(page.source.roomId).not.toBeNull();
      // Kim loses room A: she still sees her app's page, as its owner.
      updateUserById(getUserByName("Kim")!.id, { allowedRooms: [] });
      expect(await access(srv, who, page.id)).toEqual({
        morgan: true,
        kim: true,
        lee: true,
        mia: false,
      });
      const miaAck = await api(srv, `/api/pager/${page.id}/ack`, {
        method: "POST",
        rawSessionId: who.mia.rawSessionId,
      });
      expect(miaAck.status).toBe(404);
      const kimAck = await api(srv, `/api/pager/${page.id}/ack`, {
        method: "POST",
        rawSessionId: who.kim.rawSessionId,
      });
      expect(kimAck.status).toBe(200);
      expect((kimAck.body as PagerEntry).acked?.by).toBe("Kim");
      await sleep(50);
      const heard = Object.fromEntries(
        Object.entries(sockets).map(([k, ws]) => [
          k,
          pagerEvents(ws).some((e) => e.id === page.id && e.state === "acked"),
        ]),
      );
      expect(heard).toEqual({ morgan: true, kim: true, lee: true, mia: false });
    });

    it("a page with no room: the app owner and office owners only", async () => {
      const { srv, roomA, who, sockets, kimBot, kimToken } = await memberApp();
      await srv.agentManager.kill(kimBot.agent.id);
      const page = (await appRaise(srv, kimToken, { title: "down" }))
        .body as PagerEntry;
      expect(page.source.roomId).toBeNull();
      expect(await access(srv, who, page.id)).toEqual({
        morgan: true,
        kim: true,
        lee: false,
        mia: false,
      });
      for (const m of [who.lee, who.mia]) {
        for (const verb of ["ack", "resolve"]) {
          const r = await api(srv, `/api/pager/${page.id}/${verb}`, {
            method: "POST",
            rawSessionId: m.rawSessionId,
          });
          expect({ verb, status: r.status }).toEqual({ verb, status: 404 });
        }
      }
      const ack = await api(srv, `/api/pager/${page.id}/ack`, {
        method: "POST",
        rawSessionId: who.kim.rawSessionId,
      });
      expect(ack.status).toBe(200);
      const resolve = await api(srv, `/api/pager/${page.id}/resolve`, {
        method: "POST",
        rawSessionId: who.morgan.rawSessionId,
      });
      expect(resolve.status).toBe(200);
      await sleep(50);
      const heard = Object.fromEntries(
        Object.entries(sockets).map(([k, ws]) => [
          k,
          pagerEvents(ws).some((e) => e.id === page.id),
        ]),
      );
      expect(heard).toEqual({
        morgan: true,
        kim: true,
        lee: false,
        mia: false,
      });
      // A room filter leaves a page with no room out.
      const all = await api(srv, "/api/pager?state=all", {
        rawSessionId: who.morgan.rawSessionId,
      });
      expect((all.body as PagerEntry[]).map((e) => e.id)).toContain(page.id);
      const inA = await api(srv, `/api/pager?state=all&roomId=${roomA}`, {
        rawSessionId: who.morgan.rawSessionId,
      });
      expect((inA.body as PagerEntry[]).map((e) => e.id)).not.toContain(
        page.id,
      );
    });

    it("member access follows the room stored at the first raise, not the creator's room now", async () => {
      const { srv, roomA, roomB, who, kimBot, kimToken } = await memberApp();
      const page = (await appRaise(srv, kimToken, { title: "down", key: "k" }))
        .body as PagerEntry;
      expect(page.source.roomId).toBe(roomA);
      expect(srv.agentManager.moveAgent(kimBot.agent.id, roomB)).toBe(true);
      const again = (await appRaise(srv, kimToken, { title: "down", key: "k" }))
        .body as PagerEntry;
      expect(again.id).toBe(page.id);
      expect(again.source.roomId).toBe(roomA);
      expect(await access(srv, who, page.id)).toEqual({
        morgan: true,
        kim: true,
        lee: true,
        mia: false,
      });
      // A new page takes the creator's room now.
      const fresh = (await appRaise(srv, kimToken, { title: "other" }))
        .body as PagerEntry;
      expect(fresh.source.roomId).toBe(roomB);
    });
  });

  describe("app pager REST: durability", () => {
    it("after a cold restart the same app token dedupes into and resolves its page", async () => {
      const { srv, morgan, appToken } = await office();
      const first = (await appRaise(srv, appToken, { title: "down", key: "k" }))
        .body as PagerEntry;
      const restarted = await srv.restart();
      server = restarted;
      const again = await appRaise(restarted, appToken, {
        title: "down",
        key: "k",
      });
      expect(again.status).toBe(200);
      expect((again.body as PagerEntry).id).toBe(first.id);
      const r = await appResolve(restarted, appToken, { key: "k" });
      expect(r.status).toBe(200);
      expect((r.body as PagerEntry).id).toBe(first.id);
      const list = await api(restarted, "/api/pager?state=resolved", {
        rawSessionId: morgan.rawSessionId,
      });
      expect((list.body as PagerEntry[]).map((e) => e.id)).toEqual([first.id]);
    });
  });

  describe("app pager handler: an unowned app", () => {
    it("has nobody to page: 409, and nothing is stored", async () => {
      const store = createPagerStore({
        persistence: {
          load: () => ({ kind: "missing" }),
          save: () => {},
          quarantine: () => true,
        },
      });
      const h = pagerHandlers({
        store,
        viewer: () => ({
          accessibleRoomIds: new Set(["r1"]),
          userId: "u1",
          isOfficeOwner: false,
        }),
        agentSource: () => null,
        appSource: () => ({
          registrationGen: 1,
          roomId: "r1",
          ownerUserId: null,
        }),
        actorName: () => "x",
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
      expect(store.list()).toEqual([]);
    });
  });
});
