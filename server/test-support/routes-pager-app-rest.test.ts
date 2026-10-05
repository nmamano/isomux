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

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { pagerHandlers } from "../routes/handlers/pager.ts";
import type { RouteHandlerContext } from "../routes/executor.ts";
import { createPagerStore } from "../pager-store.ts";
import type { AgentInfo, PagerEntry, PagerSource } from "../../shared/types.ts";
import type { TestSocket } from "./harness.ts";

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
  managerName = "Boss",
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

// One office: owner Boss; member Mia with access to
// room B only; AppBot in room A, managed by Boss, registered app "uptime".
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
  const boss = await srv.seedOwner("Boss");
  const mia = await srv.seedMember("Mia");
  const roomA = srv.agentManager.getRooms()[0].id;
  const roomB = srv.agentManager.createRoom("Room B");
  updateUserById(getUserByName("Mia")!.id, { allowedRooms: [roomB] });
  const bot = await spawnAgent(srv, "AppBot", roomA);
  const appToken = await registerApp(srv, bot.token, "uptime");
  return { srv, boss, mia, roomA, roomB, bot, appToken, sent };
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
    expect(e.targetUserId).toBe(getUserByName("Boss")!.id);
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

  it("an app whose creator agent is gone still pages its owner, with no room", async () => {
    const { srv, boss, bot, appToken, sent } = await office();
    await saveWebhook(srv, boss);
    await srv.agentManager.kill(bot.agent.id);
    const r = await appRaise(srv, appToken, { title: "AppBot is gone" });
    expect(r.status).toBe(201);
    const e = r.body as PagerEntry;
    expect(e.source).toMatchObject({ kind: "app", roomId: null });
    expect(e.targetUserId).toBe(getUserByName("Boss")!.id);
    await sleep(50);
    expect(sent).toHaveLength(1);
    expect(sent[0].embeds?.[0].footer?.text).toBe("uptime");
    const got = await api(srv, `/api/pager/${e.id}`, {
      rawSessionId: boss.rawSessionId,
    });
    expect((got.body as PagerEntry).delivery).toMatchObject({
      state: "delivered",
      sends: 1,
    });
  });

  it("the page reaches the app owner's Discord", async () => {
    const { srv, boss, appToken, sent } = await office();
    await saveWebhook(srv, boss);
    const r = await appRaise(srv, appToken, { title: "AppBot is down" });
    expect(r.status).toBe(201);
    await sleep(50);
    expect(sent).toHaveLength(1);
    expect(sent[0].embeds?.[0].title).toBe("AppBot is down");
    const page = (
      await api(srv, `/api/pager/${(r.body as PagerEntry).id}`, {
        rawSessionId: boss.rawSessionId,
      })
    ).body as PagerEntry;
    expect(page.delivery).toMatchObject({ state: "delivered", sends: 1 });
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
    expect(appSourceOf(otherPage).appName).not.toBe(appSourceOf(mine).appName);
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
  it("an app token reaches no agent or member pager route", async () => {
    const { srv, bot, appToken } = await office();
    const page = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: bot.token,
        body: { title: "x" },
      })
    ).body as PagerEntry;
    const calls: Array<[string, string]> = [
      ["POST", "/api/pager"],
      ["GET", "/api/pager"],
      ["GET", `/api/pager/${page.id}`],
      ["POST", `/api/pager/${page.id}/ack`],
      ["POST", `/api/pager/${page.id}/resolve`],
    ];
    for (const [method, path] of calls) {
      const r = await api(srv, path, {
        method,
        bearer: appToken,
        ...(method === "POST" ? { body: { title: "x" } } : {}),
      });
      expect({ path, method, status: r.status }).toEqual({
        path,
        method,
        status: 403,
      });
    }
  });

  it("an agent token and a member session reach no app pager route", async () => {
    const { srv, boss, bot } = await office();
    for (const auth of [
      { bearer: bot.token },
      { rawSessionId: boss.rawSessionId },
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
  // A, Mia only room B, Boss is the office owner. Every one has a socket.
  async function memberApp() {
    const base = await office();
    const { srv, roomA, roomB } = base;
    const kim = await srv.seedMember("Kim");
    const lee = await srv.seedMember("Lee");
    updateUserById(getUserByName("Kim")!.id, { allowedRooms: [roomA] });
    updateUserById(getUserByName("Lee")!.id, { allowedRooms: [roomA] });
    const kimBot = await spawnAgent(srv, "KimBot", roomA, "Kim");
    const kimToken = await registerApp(srv, kimBot.token, "kim-app");
    const who = { boss: base.boss, kim, lee, mia: base.mia };
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
      boss: true,
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
    expect(heard).toEqual({ boss: true, kim: true, lee: true, mia: false });
  });

  it("a page with no room: the app owner and office owners only", async () => {
    const { srv, roomA, who, sockets, kimBot, kimToken } = await memberApp();
    await srv.agentManager.kill(kimBot.agent.id);
    const page = (await appRaise(srv, kimToken, { title: "down" }))
      .body as PagerEntry;
    expect(page.source.roomId).toBeNull();
    expect(await access(srv, who, page.id)).toEqual({
      boss: true,
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
      rawSessionId: who.boss.rawSessionId,
    });
    expect(resolve.status).toBe(200);
    await sleep(50);
    const heard = Object.fromEntries(
      Object.entries(sockets).map(([k, ws]) => [
        k,
        pagerEvents(ws).some((e) => e.id === page.id),
      ]),
    );
    expect(heard).toEqual({ boss: true, kim: true, lee: false, mia: false });
    // A room filter leaves a page with no room out.
    const all = await api(srv, "/api/pager?state=all", {
      rawSessionId: who.boss.rawSessionId,
    });
    expect((all.body as PagerEntry[]).map((e) => e.id)).toContain(page.id);
    const inA = await api(srv, `/api/pager?state=all&roomId=${roomA}`, {
      rawSessionId: who.boss.rawSessionId,
    });
    expect((inA.body as PagerEntry[]).map((e) => e.id)).not.toContain(page.id);
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
      boss: true,
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
    const { srv, boss, appToken } = await office();
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
      rawSessionId: boss.rawSessionId,
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
