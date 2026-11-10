// A Discord route ask (task 386ec4d6), through the real server: an agent
// asks the member to route a place of their Discord bots (a channel, a
// category or a whole server) to an agent, by a part of its name, since an
// agent cannot read the member's bots. The member picks the place on the
// card and Apply sends it (POST /api/asks/:id/action with {botId, guildId,
// scope, targetId}). The run adds a route for a place with none and moves a
// route that goes elsewhere; the step's settings are the whole state, so
// what it leaves out is the default. The ask closes when the place goes to
// the agent with those settings, by the card or by the Integrations page.
//
// Seam: startTestServer(). Bots written after boot are stored with no
// gateway child, and the supervisor's guild reads are stubbed: the servers a
// bot sees live in the gateway's memory.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { discordSupervisor } from "../office-managers.ts";
import {
  readDiscordRoutes,
  writeBots,
  writeDiscordRoutes,
} from "../discord/store.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";
import type { DiscordGuildSeen, DiscordRoute } from "../../shared/discord.ts";

let server: TestServer | null = null;
const folders: string[] = [];
const clients: Client[] = [];
const spies: { mockRestore(): void }[] = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

interface Res {
  status: number;
  body: unknown;
}

const BOT = "1100000000000000001";
const BOT2 = "1100000000000000002";
const CASEY_BOT = "1100000000000000009";
const GUILD = "1200000000000000001";
const GUILD2 = "1200000000000000002";
const CAT = "1300000000000000001";
const LEGAL = "1300000000000000002";
const RANDOM = "1300000000000000003";
const HELP = "1300000000000000004";
const G2_CHAN = "1300000000000000005";
const LONG_CHAN = "1300000000000000006";

const LONG_NAME = `akido-${"x".repeat(90)}`;

const AKIDO: DiscordGuildSeen = {
  id: GUILD,
  name: "Akido HQ",
  channels: [
    { id: CAT, name: "Akido Talk", kind: "category", parentId: null },
    { id: LEGAL, name: "akido-legal", kind: "text", parentId: CAT },
    { id: HELP, name: "help", kind: "forum", parentId: CAT },
    { id: RANDOM, name: "random", kind: "text", parentId: null },
    { id: LONG_CHAN, name: LONG_NAME, kind: "text", parentId: null },
  ],
};
const ELSEWHERE: DiscordGuildSeen = {
  id: GUILD2,
  name: "Elsewhere",
  channels: [{ id: G2_CHAN, name: "akido-ops", kind: "text", parentId: null }],
};

// Morgan owns the office; Casey is a member with its first room. Each has
// agents there: an agent managed by Casey is another member's agent for
// Morgan.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const casey = await srv.seedMember("Casey");
  const room = srv.agentManager.getRooms()[0].id;
  const o = {
    srv,
    room,
    morgan: morgan.rawSessionId,
    morganName: morgan.username,
    morganId: getUserByName(morgan.username)!.id,
    casey: casey.rawSessionId,
    caseyName: casey.username,
    caseyId: getUserByName(casey.username)!.id,
  };
  const rooms = await asSession(
    o,
    o.morgan,
    "PUT",
    `/api/users/${o.caseyName}/access`,
    { allowedRooms: [room] },
  );
  expect(rooms.status).toBe(200);
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function spawn(
  o: Office,
  name: string,
  manager: "Morgan" | "Casey" = "Morgan",
  roomId?: string,
): Promise<AgentInfo> {
  const cwd = mkdtempSync(join(tmpdir(), "dc-route-ask-"));
  folders.push(cwd);
  const agent = await o.srv.agentManager.spawn(
    name,
    cwd,
    "default",
    undefined,
    undefined,
    roomId ?? o.room,
    undefined,
    undefined,
    undefined,
    manager === "Morgan" ? o.morganName : o.caseyName,
    "claude",
    undefined,
    manager === "Morgan" ? o.morganId : o.caseyId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

// The servers each bot sees, by bot id: what the gateway would hold.
let seen: Record<string, DiscordGuildSeen[]> = {};
// Which member each bot is stored for.
let owners: Record<string, string> = {};

// The member's bots, stored with these routes; each bot sees `guilds`.
function connect(
  o: Office,
  userId: string,
  bots: { id: string; guilds: DiscordGuildSeen[] }[],
  routes: DiscordRoute[] = [],
) {
  writeBots(
    o.srv.stateRoot,
    userId,
    bots.map((b) => ({
      id: b.id,
      name: `Bot ${b.id.slice(-1)}`,
      token: `token-${b.id}`,
      addedAt: 1,
    })),
  );
  writeDiscordRoutes(o.srv.stateRoot, userId, routes);
  for (const b of bots) {
    seen[b.id] = b.guilds;
    owners[b.id] = userId;
  }
  if (spies.length === 0) {
    spies.push(
      spyOn(discordSupervisor, "guilds").mockImplementation(
        (id: string, botId: string) =>
          owners[botId] === id ? (seen[botId] ?? null) : null,
      ),
      spyOn(discordSupervisor, "guildsOfBot").mockImplementation(
        (botId: string) => seen[botId] ?? null,
      ),
    );
  }
}
afterEach(() => {
  seen = {};
  owners = {};
});

const routesOf = (o: Office, userId: string) =>
  readDiscordRoutes(o.srv.stateRoot, userId);

async function read(res: Response): Promise<Res> {
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function asSession(
  o: Office,
  session: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return read(
    await o.srv.http(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      rawSessionId: session,
    }),
  );
}

async function asAgent(
  o: Office,
  agentId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return read(
    await o.srv.http(path, {
      method,
      headers: {
        Authorization: `Bearer ${getAgentTokenRaw(agentId)}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const codeOf = (res: Res) =>
  (res.body as { error?: { code?: string } } | null)?.error?.code;
const outcome = (res: Res) => ({ status: res.status, code: codeOf(res) });

const routeStep = (
  agentId: string,
  placeName: string,
  extra: Record<string, unknown> = {},
) => ({ kind: "discord-route", placeName, agentId, ...extra });

function ask(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
): Promise<Res> {
  return asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Please route this place.",
    step,
  });
}

async function opened(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
): Promise<AskEntry> {
  const res = await ask(o, askerId, step);
  expect(outcome(res)).toEqual({ status: 201, code: undefined });
  return res.body as AskEntry;
}

function apply(
  o: Office,
  session: string,
  askId: string,
  body?: unknown,
): Promise<Res> {
  return asSession(o, session, "POST", `/api/asks/${askId}/action`, body);
}

async function askStatus(o: Office, askerId: string, askId: string) {
  const res = await asAgent(
    o,
    askerId,
    "GET",
    `/api/agents/${askerId}/asks/${askId}`,
  );
  if (res.status !== 200) return String(res.status);
  return (
    (res.body as { closed?: { outcome: string } }).closed?.outcome ?? "open"
  );
}

async function waitUntil(pred: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(10);
  }
}

const closesDone = (o: Office, askerId: string, askId: string) =>
  waitUntil(
    async () => (await askStatus(o, askerId, askId)) === "done",
    "the ask closes as done",
  );

// The step lines in the agent's chat, as JSON.
const stepLines = (o: Office, agentId: string) =>
  o.srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => JSON.stringify(e))
    .filter((json) => /systemEntries\.stepAsk\.\w+/.test(json));

const route = (
  id: string,
  targetId: string,
  agentId: string,
  extra: Partial<DiscordRoute> = {},
): DiscordRoute => ({
  id,
  botId: BOT,
  guildId: GUILD,
  scope: "channel",
  targetId,
  name: `Route ${id}`,
  agentId,
  trigger: "mention",
  replyMode: "ask",
  createdAt: 1,
  ...extra,
});

// The fields of a route that the step sets, with the defaults as stored.
const settingsOf = (r: DiscordRoute | undefined) =>
  r && {
    agentId: r.agentId,
    trigger: r.trigger,
    replyMode: r.replyMode,
    prefix: r.prefix,
    includeBots: r.includeBots,
    react: r.react,
  };

const pickOf = (
  targetId: string,
  scope: "channel" | "category" | "server" = "channel",
  guildId = GUILD,
  botId = BOT,
) => ({ botId, guildId, scope, targetId });

describe("a discord-route ask at create", () => {
  it("opens for the member with the step as sent, no link, and nothing written; an owner may route to another member's agent", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const pm = await spawn(o, "PM", "Casey");
    connect(o, o.morganId, [{ id: BOT, guilds: [AKIDO] }]);
    const entry = await opened(
      o,
      asker.id,
      routeStep(pm.id, "#akido", { scope: "channel", replyMode: "bot" }),
    );
    expect([entry.step, entry.link]).toEqual([
      {
        kind: "discord-route",
        placeName: "#akido",
        agentId: pm.id,
        scope: "channel",
        replyMode: "bot",
      },
      undefined,
    ]);
    expect(routesOf(o, o.morganId)).toEqual([]);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("refuses a step that is not well formed: 400 invalid_request, nothing opened", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Helper");
    connect(o, o.morganId, [{ id: BOT, guilds: [AKIDO] }]);
    for (const step of [
      routeStep(target.id, ""),
      routeStep(target.id, "   "),
      routeStep(target.id, "akido\nlegal"),
      routeStep(target.id, "x".repeat(61)),
      { kind: "discord-route", agentId: target.id },
      { kind: "discord-route", placeName: "akido" },
      routeStep(target.id, "akido", { targetId: LEGAL }),
      routeStep(target.id, "akido", { scope: "thread" }),
      routeStep(target.id, "akido", { trigger: "everything" }),
      routeStep(target.id, "akido", { replyMode: "auto" }),
      routeStep(target.id, "akido", { includeBots: "yes" }),
      routeStep(target.id, "akido", { react: 1 }),
      routeStep(target.id, "akido", { prefix: "x".repeat(41) }),
    ])
      expect({ step, ...outcome(await ask(o, asker.id, step)) }).toEqual({
        step,
        status: 400,
        code: "invalid_request",
      });
    const asks = await asSession(o, o.morgan, "GET", "/api/asks");
    expect((asks.body as unknown[]).length).toBe(0);
  });

  it("refuses with one code per reason: no bot, an agent out of reach, an agent the member may not route to, an agent at Chat stop, a step already done", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const caseyAsker = await spawn(o, "CaseyAsker", "Casey");
    const chatOnly = await spawn(o, "Quiet");
    // A room Casey has no access to.
    const back = o.srv.agentManager.createRoom("Back");
    const away = await spawn(o, "Away", "Morgan", back);
    const lowered = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${chatOnly.id}/access`,
      { access: "chat" },
    );
    expect(lowered.status).toBe(200);

    // Morgan has no bot yet.
    expect(
      outcome(await ask(o, asker.id, routeStep(helper.id, "akido"))),
    ).toEqual({ status: 409, code: "discord_not_connected" });

    connect(
      o,
      o.morganId,
      [{ id: BOT, guilds: [AKIDO] }],
      [route("d_1", LEGAL, helper.id)],
    );
    connect(o, o.caseyId, [{ id: CASEY_BOT, guilds: [AKIDO] }]);

    // Casey's agent cannot reach the back room: the same answer as no agent.
    for (const agentId of ["agent-none", away.id])
      expect(
        outcome(await ask(o, caseyAsker.id, routeStep(agentId, "akido"))),
      ).toEqual({ status: 422, code: "unknown_agent" });
    // Casey is no owner, and Helper is Morgan's.
    expect(
      outcome(await ask(o, caseyAsker.id, routeStep(helper.id, "akido"))),
    ).toEqual({ status: 403, code: "member_not_allowed" });
    expect(
      outcome(await ask(o, asker.id, routeStep(chatOnly.id, "akido"))),
    ).toEqual({ status: 422, code: "agent_chat_only" });
    // d_1 already sends #akido-legal to Helper, on a mention, replies
    // waiting for Send.
    expect(
      outcome(await ask(o, asker.id, routeStep(helper.id, "#AKIDO-legal"))),
    ).toEqual({ status: 409, code: "step_done" });
    const asks = await asSession(o, o.morgan, "GET", "/api/asks");
    expect((asks.body as unknown[]).length).toBe(0);
  });

  it("is not done while the matching route differs in any one setting, is dead, or is a place the step does not name", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(
      o,
      o.morganId,
      [{ id: BOT, guilds: [AKIDO] }],
      [
        route("d_1", LEGAL, helper.id, { replyMode: "bot", react: true }),
        route("d_2", RANDOM, helper.id, { dead: "agent_chat_only" }),
        route("d_3", CAT, helper.id, { scope: "category" }),
        route("d_4", HELP, helper.id, {
          trigger: "all",
          replyMode: "read",
          prefix: "[x]",
          includeBots: true,
          react: true,
        }),
      ],
    );
    // Replies wait for Send asked; d_1 posts at once and reacts.
    await opened(o, asker.id, routeStep(helper.id, "legal"));
    // A trigger asked; d_1 waits for a mention.
    await opened(
      o,
      asker.id,
      routeStep(helper.id, "legal", {
        trigger: "all",
        replyMode: "bot",
        react: true,
      }),
    );
    // d_2 has the default settings but is dead.
    await opened(o, asker.id, routeStep(helper.id, "random"));
    // d_3 is the category "Akido Talk"; a channel scope does not take it.
    await opened(
      o,
      asker.id,
      routeStep(helper.id, "akido talk", { scope: "channel" }),
    );
    // The same settings as d_1: done.
    expect(
      outcome(
        await ask(
          o,
          asker.id,
          routeStep(helper.id, "legal", { replyMode: "bot", react: true }),
        ),
      ),
    ).toEqual({ status: 409, code: "step_done" });
    // One setting apart from d_4, each in turn: not done.
    const full = {
      trigger: "all",
      replyMode: "read",
      prefix: "[x]",
      includeBots: true,
      react: true,
    };
    for (const [key, apart] of [
      ["trigger", "mention"],
      ["replyMode", "ask"],
      ["prefix", "[y]"],
      ["includeBots", false],
      ["react", false],
    ] as const) {
      const step = routeStep(helper.id, "help", { ...full, [key]: apart });
      expect({ key, ...outcome(await ask(o, asker.id, step)) }).toEqual({
        key,
        status: 201,
        code: undefined,
      });
    }
    expect(
      outcome(await ask(o, asker.id, routeStep(helper.id, "help", full))),
    ).toEqual({ status: 409, code: "step_done" });
    // d_3 with no scope, or the category scope: done.
    for (const extra of [{}, { scope: "category" }])
      expect({
        extra,
        ...outcome(
          await ask(o, asker.id, routeStep(helper.id, "akido talk", extra)),
        ),
      }).toEqual({ extra, status: 409, code: "step_done" });
  });
});

describe("a discord-route ask at run", () => {
  it("adds a route for the picked channel with the default settings, to another member's agent, named by the channel; the ask closes as done with a line that names only the asked name", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const pm = await spawn(o, "PM", "Casey");
    connect(o, o.morganId, [{ id: BOT, guilds: [AKIDO] }]);
    const entry = await opened(o, asker.id, routeStep(pm.id, "kido-le"));

    const ran = await apply(o, o.morgan, entry.id, pickOf(LEGAL));
    expect(ran.status).toBeLessThan(300);
    const routes = routesOf(o, o.morganId);
    expect(routes.length).toBe(1);
    expect(routes[0]).toMatchObject({
      botId: BOT,
      guildId: GUILD,
      scope: "channel",
      targetId: LEGAL,
      name: "akido-legal",
    });
    expect(settingsOf(routes[0])).toEqual({
      agentId: pm.id,
      trigger: "mention",
      replyMode: "ask",
      prefix: undefined,
      includeBots: undefined,
      react: undefined,
    });
    expect(routes[0].dead).toBeUndefined();
    await closesDone(o, asker.id, entry.id);
    const lines = stepLines(o, asker.id);
    expect(lines.length).toBe(1);
    expect(lines[0].includes("kido-le")).toBe(true);
    // The agent learns no Discord name it did not give.
    for (const name of ["akido-legal", "Akido HQ"])
      expect({ name, inLine: lines[0].includes(name) }).toEqual({
        name,
        inLine: false,
      });
    // The member's Integrations list shows the route live.
    const listed = await asSession(o, o.morgan, "GET", "/api/discord/routes");
    expect(
      (listed.body as DiscordRoute[]).map((r) => [r.agentId, r.dead ?? null]),
    ).toEqual([[pm.id, null]]);
  });

  it("sets each setting the step names", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(o, o.morganId, [{ id: BOT, guilds: [AKIDO] }]);
    const entry = await opened(
      o,
      asker.id,
      routeStep(helper.id, "legal", {
        trigger: "all",
        replyMode: "read",
        prefix: "[bot]",
        includeBots: true,
        react: true,
      }),
    );
    expect(
      (await apply(o, o.morgan, entry.id, pickOf(LEGAL))).status,
    ).toBeLessThan(300);
    expect(settingsOf(routesOf(o, o.morganId)[0])).toEqual({
      agentId: helper.id,
      trigger: "all",
      replyMode: "read",
      prefix: "[bot]",
      includeBots: true,
      react: true,
    });
    await closesDone(o, asker.id, entry.id);
  });

  it("routes a category and a whole server: the target is the category, or the server itself, named by its Discord name", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(o, o.morganId, [{ id: BOT, guilds: [AKIDO] }]);
    const cat = await opened(o, asker.id, routeStep(helper.id, "talk"));
    expect(
      (await apply(o, o.morgan, cat.id, pickOf(CAT, "category"))).status,
    ).toBeLessThan(300);
    await closesDone(o, asker.id, cat.id);
    const whole = await opened(
      o,
      asker.id,
      routeStep(helper.id, "hq", { scope: "server" }),
    );
    expect(
      (await apply(o, o.morgan, whole.id, pickOf(GUILD, "server"))).status,
    ).toBeLessThan(300);
    await closesDone(o, asker.id, whole.id);
    expect(
      routesOf(o, o.morganId).map((r) => [r.scope, r.targetId, r.name]),
    ).toEqual([
      ["category", CAT, "Akido Talk"],
      ["server", GUILD, "Akido HQ"],
    ]);
  });

  it("moves a route that goes to another agent: the same route, the member's name kept, the step's settings and no others; a dead route there moves and is live again", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const pm = await spawn(o, "PM", "Casey");
    connect(
      o,
      o.morganId,
      [{ id: BOT, guilds: [AKIDO] }],
      [
        route("d_1", LEGAL, helper.id, {
          name: "My legal",
          trigger: "all",
          replyMode: "bot",
          prefix: "[x]",
          includeBots: true,
          react: true,
        }),
        route("d_2", RANDOM, helper.id),
        route("d_3", HELP, "agent-gone", { dead: "agent_gone" }),
      ],
    );
    const entry = await opened(o, asker.id, routeStep(pm.id, "legal"));
    expect(
      (await apply(o, o.morgan, entry.id, pickOf(LEGAL))).status,
    ).toBeLessThan(300);
    const after = routesOf(o, o.morganId);
    expect(after.map((r) => [r.id, r.targetId, r.name])).toEqual([
      ["d_1", LEGAL, "My legal"],
      ["d_2", RANDOM, "Route d_2"],
      ["d_3", HELP, "Route d_3"],
    ]);
    expect(settingsOf(after[0])).toEqual({
      agentId: pm.id,
      trigger: "mention",
      replyMode: "ask",
      prefix: undefined,
      includeBots: undefined,
      react: undefined,
    });
    expect(settingsOf(after[1])?.agentId).toBe(helper.id);
    await closesDone(o, asker.id, entry.id);

    const help = await opened(o, asker.id, routeStep(helper.id, "help"));
    expect(
      (await apply(o, o.morgan, help.id, pickOf(HELP))).status,
    ).toBeLessThan(300);
    const moved = routesOf(o, o.morganId).find((r) => r.id === "d_3");
    expect([moved?.agentId, moved?.dead ?? null]).toEqual([helper.id, null]);
    await closesDone(o, asker.id, help.id);
  });

  it("names a new route by the Discord name cut to the route name's length", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(o, o.morganId, [{ id: BOT, guilds: [AKIDO] }]);
    const entry = await opened(o, asker.id, routeStep(helper.id, "xxxx"));
    expect(
      (await apply(o, o.morgan, entry.id, pickOf(LONG_CHAN))).status,
    ).toBeLessThan(300);
    const routes = routesOf(o, o.morganId);
    expect(routes.length).toBe(1);
    expect(LONG_NAME.startsWith(routes[0].name)).toBe(true);
    expect([...routes[0].name].length).toBe(60);
  });

  it("takes a place of the member's second bot", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(o, o.morganId, [
      { id: BOT, guilds: [AKIDO] },
      { id: BOT2, guilds: [ELSEWHERE] },
    ]);
    const entry = await opened(o, asker.id, routeStep(helper.id, "akido"));
    expect(
      (
        await apply(
          o,
          o.morgan,
          entry.id,
          pickOf(G2_CHAN, "channel", GUILD2, BOT2),
        )
      ).status,
    ).toBeLessThan(300);
    expect(
      routesOf(o, o.morganId).map((r) => [r.botId, r.guildId, r.targetId]),
    ).toEqual([[BOT2, GUILD2, G2_CHAN]]);
    await closesDone(o, asker.id, entry.id);
  });

  it("refuses a pick that is not well formed (400), and one that is not a matching place of the member's bots (409), and writes nothing", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(o, o.morganId, [
      { id: BOT, guilds: [AKIDO] },
      { id: BOT2, guilds: [ELSEWHERE] },
    ]);
    connect(o, o.caseyId, [{ id: CASEY_BOT, guilds: [AKIDO] }]);
    const entry = await opened(
      o,
      asker.id,
      routeStep(helper.id, "akido", { scope: "channel" }),
    );
    for (const body of [
      undefined,
      {},
      { botId: BOT, guildId: GUILD, scope: "channel" },
      { ...pickOf(LEGAL), targetId: 7 },
      { ...pickOf(LEGAL), botId: null },
      { ...pickOf(LEGAL), scope: "thread" },
    ])
      expect({
        body,
        ...outcome(await apply(o, o.morgan, entry.id, body)),
      }).toEqual({ body, status: 400, code: "invalid_request" });
    for (const [why, body] of [
      // The member's channel, but not an Akido one.
      ["no match", pickOf(RANDOM)],
      // The category matches, but the step names channels.
      ["scope left out", pickOf(CAT, "category")],
      // A matching channel, sent as another kind.
      ["wrong scope", pickOf(LEGAL, "category")],
      // A matching channel in the wrong server.
      ["wrong server", pickOf(LEGAL, "channel", GUILD2)],
      // A matching channel seen by the other bot only.
      ["wrong bot", pickOf(LEGAL, "channel", GUILD, BOT2)],
      // Casey's bot sees Akido HQ, but it is not Morgan's.
      ["another member's bot", pickOf(LEGAL, "channel", GUILD, CASEY_BOT)],
      ["no such place", pickOf("1300000000000000099")],
    ] as const)
      expect({
        why,
        ...outcome(await apply(o, o.morgan, entry.id, body)),
      }).toEqual({ why, status: 409, code: "place_not_matching" });
    expect(routesOf(o, o.morganId)).toEqual([]);
    expect(routesOf(o, o.caseyId)).toEqual([]);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("closes the ask when the member adds the route on the Integrations page", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(o, o.morganId, [{ id: BOT, guilds: [AKIDO] }]);
    const entry = await opened(o, asker.id, routeStep(helper.id, "legal"));
    const added = await asSession(o, o.morgan, "POST", "/api/discord/routes", {
      botId: BOT,
      guildId: GUILD,
      scope: "channel",
      targetId: LEGAL,
      name: "Legal",
      agentId: helper.id,
    });
    expect(added.status).toBeLessThan(300);
    await closesDone(o, asker.id, entry.id);
  });

  it("closes the ask when the member changes an existing route to the step's settings on the Integrations page", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(
      o,
      o.morganId,
      [{ id: BOT, guilds: [AKIDO] }],
      [route("d_1", LEGAL, helper.id, { replyMode: "bot" })],
    );
    const entry = await opened(o, asker.id, routeStep(helper.id, "legal"));
    const changed = await asSession(
      o,
      o.morgan,
      "PATCH",
      "/api/discord/routes/d_1",
      { replyMode: "ask" },
    );
    expect(changed.status).toBeLessThan(300);
    await closesDone(o, asker.id, entry.id);
  });
});

describe("a discord-route ask from /mcp", () => {
  it("open_ask keeps every field of the step", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    connect(o, o.morganId, [{ id: BOT, guilds: [AKIDO] }]);
    // /mcp takes an agent below Standard.
    const lowered = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${asker.id}/access`,
      { access: "office" },
    );
    expect(lowered.status).toBe(200);
    const client = new Client({ name: "dc-route-ask-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(asker.id)}` },
        },
      }),
    );
    clients.push(client);
    const step = routeStep(helper.id, "legal", {
      scope: "channel",
      trigger: "all",
      replyMode: "bot",
      prefix: "[bot]",
      includeBots: true,
      react: true,
    });
    const result = (await client.callTool({
      name: "open_ask",
      arguments: { prompt: "Please route this place.", step },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError ?? false).toBe(false);
    const entry = JSON.parse(result.content?.[0]?.text ?? "{}") as AskEntry;
    expect(entry.step as unknown).toEqual(step);
  });
});
