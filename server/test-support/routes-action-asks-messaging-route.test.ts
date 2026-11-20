// A messaging-route ask (task 2ff2729f), through the real server: an agent
// asks the member to change some settings of one existing route of theirs,
// in Discord or WhatsApp, named by its id (the head line of each delivery
// gives it). The server finds the route's app at the create and stores it.
// Apply sends one PATCH of that route with `set`, as the member: only the
// keys of `set` change. The ask closes when the route is live and has every
// value of `set`, by the card or by hand.
//
// Seam: startTestServer(). Routes and rows are written to the store after
// boot; no bot or bridge runs, and the PATCH routes do not need one.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { whatsappSupervisor } from "../office-managers.ts";
import {
  readDiscordRoutes,
  writeBots,
  writeDiscordRoutes,
} from "../discord/store.ts";
import { writeLink } from "../whatsapp/store.ts";
import { readRoutes, writeRoutes } from "../whatsapp/routes-store.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";
import type { DiscordRoute } from "../../shared/discord.ts";
import type { WhatsAppRoute } from "../../shared/whatsapp.ts";

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
const GUILD = "1200000000000000001";
const LEGAL = "1300000000000000002";
const RANDOM = "1300000000000000003";
const HELP = "1300000000000000004";
const PHONE = "447700900111";
const GROUP = "120363000000000001@g.us";
const CONTACT = "447700900123@s.whatsapp.net";

// Morgan owns the office; Casey is a member with its first room.
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
  const cwd = mkdtempSync(join(tmpdir(), "msg-route-ask-"));
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

// The member's Discord routes, with one bot stored so the member has
// Discord set up.
function discordRoutes(o: Office, userId: string, routes: DiscordRoute[]) {
  writeBots(o.srv.stateRoot, userId, [
    { id: BOT, name: "Bot 1", token: `token-${BOT}`, addedAt: 1 },
  ]);
  writeDiscordRoutes(o.srv.stateRoot, userId, routes);
}

// The member linked to WhatsApp, with these rows; the bridge saw nothing.
function whatsappRows(o: Office, userId: string, routes: WhatsAppRoute[]) {
  writeLink(o.srv.stateRoot, userId, { phone: PHONE, linkedAt: Date.now() });
  writeRoutes(o.srv.stateRoot, userId, { phone: PHONE, routes });
  if (spies.length === 0)
    spies.push(
      spyOn(whatsappSupervisor, "chatsSeen").mockImplementation(() => []),
    );
}

const dcRoutesOf = (o: Office, userId: string) =>
  readDiscordRoutes(o.srv.stateRoot, userId);
const waRowsOf = (o: Office, userId: string) =>
  readRoutes(o.srv.stateRoot, userId).routes;

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

const step = (routeId: unknown, set: unknown) => ({
  kind: "messaging-route",
  routeId,
  set,
});

// The asking agent's POST /asks; `member` names another member than its
// manager.
function ask(
  o: Office,
  askerId: string,
  body: Record<string, unknown>,
  member?: string,
): Promise<Res> {
  return asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Please change this route.",
    step: body,
    ...(member ? { member } : {}),
  });
}

async function opened(
  o: Office,
  askerId: string,
  body: Record<string, unknown>,
  member?: string,
): Promise<AskEntry> {
  const res = await ask(o, askerId, body, member);
  expect(outcome(res)).toEqual({ status: 201, code: undefined });
  return res.body as AskEntry;
}

const apply = (o: Office, session: string, askId: string) =>
  asSession(o, session, "POST", `/api/asks/${askId}/action`);

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

// The ask stays open: a reconcile that would close it runs on the store's
// change hook, so give it a moment first.
async function staysOpen(o: Office, askerId: string, askId: string) {
  await Bun.sleep(50);
  expect(await askStatus(o, askerId, askId)).toBe("open");
}

// The step lines in the agent's chat, as JSON.
const stepLines = (o: Office, agentId: string) =>
  o.srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => JSON.stringify(e))
    .filter((json) => /systemEntries\.stepAsk\.\w+/.test(json));

const asksOf = async (o: Office, session: string) =>
  (await asSession(o, session, "GET", "/api/asks")).body as unknown[];

const dcRoute = (
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

const waRow = (
  id: string,
  chat: string,
  agentId: string,
  extra: Partial<WhatsAppRoute> = {},
): WhatsAppRoute => ({
  id,
  chat,
  group: chat.endsWith("@g.us"),
  name: `Row ${id}`,
  agentId,
  ...(chat.endsWith("@g.us") ? { trigger: "mention" as const } : {}),
  createdAt: 1,
  ...extra,
});

describe("a messaging-route ask at create", () => {
  it("opens for the member with the route's app stored and `set` as normalised, and changes nothing; an agent of another manager may open it for the route's member", async () => {
    const o = await office();
    // Casey's agent asks for Morgan: the PM asking for a route that is not
    // its manager's.
    const asker = await spawn(o, "Asker", "Casey");
    const helper = await spawn(o, "Helper");
    const routes = [dcRoute("d_1", LEGAL, helper.id, { replyMode: "read" })];
    discordRoutes(o, o.morganId, routes);
    whatsappRows(o, o.morganId, [waRow("r_1", GROUP, helper.id)]);

    const dc = await opened(
      o,
      asker.id,
      step("d_1", { replyMode: "ask", name: "  Legal  ", prefix: " [x] " }),
      o.morganName,
    );
    expect([dc.step, dc.link]).toEqual([
      {
        kind: "messaging-route",
        app: "discord",
        routeId: "d_1",
        set: { replyMode: "ask", name: "Legal", prefix: "[x]" },
      },
      undefined,
    ]);
    const wa = await opened(
      o,
      asker.id,
      step("r_1", { sendDirect: true }),
      o.morganName,
    );
    expect(wa.step as unknown).toEqual({
      kind: "messaging-route",
      app: "whatsapp",
      routeId: "r_1",
      set: { sendDirect: true },
    });
    expect(dcRoutesOf(o, o.morganId)).toEqual(routes);
    expect(waRowsOf(o, o.morganId)).toEqual([waRow("r_1", GROUP, helper.id)]);
    expect(await askStatus(o, asker.id, dc.id)).toBe("open");
  });

  it("refuses a step that is not well formed, a key of the other app, a key the route does not take and a bad value: 400 invalid_request, nothing opened", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    discordRoutes(o, o.morganId, [dcRoute("d_1", LEGAL, helper.id)]);
    whatsappRows(o, o.morganId, [
      waRow("r_1", GROUP, helper.id),
      waRow("r_2", CONTACT, helper.id),
    ]);
    const bad: [string, Record<string, unknown>][] = [
      ["no routeId", { kind: "messaging-route", set: { react: true } }],
      ["an empty routeId", step("", { react: true })],
      ["a routeId not a string", step(7, { react: true })],
      ["no set", { kind: "messaging-route", routeId: "d_1" }],
      ["an empty set", step("d_1", {})],
      ["a set that is a list", step("d_1", ["react"])],
      ["a set that is a string", step("d_1", "react")],
      ["the app sent by the agent", { ...step("d_1", {}), app: "discord" }],
      ["an extra key", { ...step("d_1", { react: true }), scope: "channel" }],
      ["an unknown key", step("d_1", { react: true, colour: "red" })],
      ["a WhatsApp key on a Discord route", step("d_1", { sendDirect: true })],
      ["a Discord key on a WhatsApp row", step("r_1", { replyMode: "bot" })],
      ["a Discord key on a WhatsApp row", step("r_1", { react: true })],
      ["a bad reply mode", step("d_1", { replyMode: "auto" })],
      ["a bad Discord trigger", step("d_1", { trigger: "everything" })],
      ["a bad WhatsApp trigger", step("r_1", { trigger: "everything" })],
      ["a switch not a boolean", step("d_1", { includeBots: "yes" })],
      ["a switch not a boolean", step("r_1", { ownMessages: 1 })],
      ["a prefix too long", step("d_1", { prefix: "x".repeat(41) })],
      ["a prefix on two lines", step("r_1", { prefix: "a\nb" })],
      ["an empty name", step("d_1", { name: "  " })],
      ["a name too long", step("r_1", { name: "x".repeat(61) })],
      ["an agentId not a string", step("d_1", { agentId: 7 })],
      // A trigger is for a group row only.
      ["a trigger on a contact row", step("r_2", { trigger: "all" })],
    ];
    for (const [label, body] of bad)
      expect({ label, ...outcome(await ask(o, asker.id, body)) }).toEqual({
        label,
        status: 400,
        code: "invalid_request",
      });
    expect((await asksOf(o, o.morgan)).length).toBe(0);
  });

  it("refuses a route the member does not have, another member's route included, with one answer that names nothing of the route", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const caseyAgent = await spawn(o, "CaseyAgent", "Casey");
    discordRoutes(o, o.morganId, [dcRoute("d_1", LEGAL, helper.id)]);
    discordRoutes(o, o.caseyId, [
      dcRoute("d_9", RANDOM, caseyAgent.id, { name: "Casey secret route" }),
    ]);
    whatsappRows(o, o.caseyId, [
      waRow("r_9", GROUP, caseyAgent.id, { name: "Casey secret row" }),
    ]);
    for (const routeId of ["d_404", "r_404", "d_9", "r_9"]) {
      const res = await ask(o, asker.id, step(routeId, { react: true }));
      expect({ routeId, ...outcome(res) }).toEqual({
        routeId,
        status: 422,
        code: "unknown_route",
      });
      const body = JSON.stringify(res.body);
      for (const leak of ["Casey secret", "discord", "whatsapp", "Discord"])
        expect({ routeId, leak, inBody: body.includes(leak) }).toEqual({
          routeId,
          leak,
          inBody: false,
        });
    }
    expect((await asksOf(o, o.morgan)).length).toBe(0);
  });

  it("judges the agent the route has after the change by the routes' own rule: set.agentId out of reach, another member's agent for a member who is no owner, an agent at Chat stop; and the route's own agent when set leaves it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseyAsker = await spawn(o, "CaseyAsker", "Casey");
    const helper = await spawn(o, "Helper");
    const caseyAgent = await spawn(o, "CaseyAgent", "Casey");
    const quiet = await spawn(o, "Quiet");
    const back = o.srv.agentManager.createRoom("Back");
    const away = await spawn(o, "Away", "Morgan", back);
    const lowered = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${quiet.id}/access`,
      { access: "chat" },
    );
    expect(lowered.status).toBe(200);
    discordRoutes(o, o.morganId, [
      dcRoute("d_1", LEGAL, helper.id),
      // The route's own agent is at Chat stop now; nothing marked it yet.
      dcRoute("d_2", RANDOM, quiet.id),
      dcRoute("d_3", HELP, "agent-gone", { dead: "agent_gone" }),
    ]);
    discordRoutes(o, o.caseyId, [dcRoute("d_7", LEGAL, caseyAgent.id)]);
    whatsappRows(o, o.morganId, [waRow("r_1", GROUP, quiet.id)]);

    // Casey's agent cannot reach the back room: the same answer as no agent.
    for (const agentId of ["agent-none", away.id])
      expect(
        outcome(await ask(o, caseyAsker.id, step("d_7", { agentId }))),
      ).toEqual({ status: 422, code: "unknown_agent" });
    // Casey is no owner, and Helper is Morgan's.
    expect(
      outcome(await ask(o, caseyAsker.id, step("d_7", { agentId: helper.id }))),
    ).toEqual({ status: 403, code: "member_not_allowed" });
    expect(
      outcome(await ask(o, asker.id, step("d_1", { agentId: quiet.id }))),
    ).toEqual({ status: 422, code: "agent_chat_only" });
    // `set` leaves the agent: the route's own agent must still be fit, or
    // Apply could only fail.
    expect(
      outcome(await ask(o, asker.id, step("d_2", { replyMode: "bot" }))),
    ).toEqual({ status: 422, code: "agent_chat_only" });
    expect(
      outcome(await ask(o, asker.id, step("r_1", { sendDirect: true }))),
    ).toEqual({ status: 422, code: "agent_chat_only" });
    expect(
      outcome(await ask(o, asker.id, step("d_3", { prefix: "[x]" }))),
    ).toEqual({ status: 422, code: "unknown_agent" });
    expect((await asksOf(o, o.morgan)).length).toBe(0);
    expect((await asksOf(o, o.casey)).length).toBe(0);

    // A fit agent for the route whose agent is at Chat stop or gone opens.
    await opened(o, asker.id, step("d_2", { agentId: helper.id }));
    await opened(o, asker.id, step("d_3", { agentId: helper.id }));
    // An owner may give the route another member's agent.
    await opened(o, asker.id, step("d_1", { agentId: caseyAgent.id }));
  });

  it("is done (409 step_done) when the live route has every value of `set`, the stored defaults included, and not while one value differs or the route is dead", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    discordRoutes(o, o.morganId, [
      dcRoute("d_1", LEGAL, helper.id, { name: "My route", replyMode: "read" }),
      dcRoute("d_2", HELP, helper.id, {
        trigger: "all",
        replyMode: "bot",
        prefix: "[x]",
        includeBots: true,
        react: true,
      }),
      // Marked dead when its agent was at Chat stop; the agent is fit now,
      // but only a PATCH makes the route live again.
      dcRoute("d_3", RANDOM, helper.id, { dead: "agent_chat_only" }),
    ]);
    whatsappRows(o, o.morganId, [
      waRow("r_1", GROUP, helper.id),
      waRow("r_2", CONTACT, helper.id, {
        sendDirect: true,
        prefix: "[y]",
        ownMessages: true,
      }),
    ]);
    const done: [string, Record<string, unknown>][] = [
      ["d_1", { replyMode: "read" }],
      ["d_1", { name: "  My route ", agentId: helper.id }],
      // Off and no prefix are stored as no key.
      ["d_1", { trigger: "mention", prefix: "", includeBots: false }],
      ["d_1", { react: false }],
      [
        "d_2",
        {
          trigger: "all",
          replyMode: "bot",
          prefix: "[x]",
          includeBots: true,
          react: true,
        },
      ],
      ["r_1", { trigger: "mention", sendDirect: false, ownMessages: false }],
      ["r_1", { prefix: "" }],
      ["r_2", { sendDirect: true, prefix: "[y]", ownMessages: true }],
    ];
    for (const [routeId, set] of done)
      expect({
        routeId,
        set,
        ...outcome(await ask(o, asker.id, step(routeId, set))),
      }).toEqual({ routeId, set, status: 409, code: "step_done" });
    expect((await asksOf(o, o.morgan)).length).toBe(0);

    const apart: [string, Record<string, unknown>][] = [
      ["d_1", { replyMode: "ask" }],
      ["d_1", { name: "Other" }],
      ["d_1", { trigger: "all" }],
      ["d_1", { prefix: "[x]" }],
      ["d_1", { includeBots: true }],
      ["d_1", { react: true }],
      // One key apart, the others equal.
      ["d_2", { trigger: "all", replyMode: "bot", react: false }],
      ["r_1", { trigger: "all" }],
      ["r_1", { sendDirect: true }],
      ["r_2", { sendDirect: true, prefix: "[y]", ownMessages: false }],
      // Every value equal, but the route is dead.
      ["d_3", { agentId: helper.id }],
      ["d_3", { replyMode: "ask" }],
    ];
    for (const [routeId, set] of apart)
      expect({
        routeId,
        set,
        ...outcome(await ask(o, asker.id, step(routeId, set))),
      }).toEqual({ routeId, set, status: 201, code: undefined });
  });
});

describe("a messaging-route ask at run", () => {
  it("changes only the keys of `set` on the Discord route, as the member; the ask closes as done with one line that names the route id and not its name", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker", "Casey");
    const helper = await spawn(o, "Helper");
    const before = dcRoute("d_1", LEGAL, helper.id, {
      name: "Isomux Discord",
      trigger: "all",
      replyMode: "read",
      prefix: "[x]",
      includeBots: true,
      react: true,
    });
    const other = dcRoute("d_2", RANDOM, helper.id, { replyMode: "read" });
    discordRoutes(o, o.morganId, [before, other]);
    const entry = await opened(
      o,
      asker.id,
      step("d_1", { replyMode: "ask" }),
      o.morganName,
    );
    expect((await apply(o, o.morgan, entry.id)).status).toBeLessThan(300);
    expect(dcRoutesOf(o, o.morganId)).toEqual([
      { ...before, replyMode: "ask" },
      other,
    ]);
    await closesDone(o, asker.id, entry.id);
    const lines = stepLines(o, asker.id);
    expect(lines.length).toBe(1);
    expect(lines[0].includes("d_1")).toBe(true);
    // The agent learns no route name it did not give.
    expect(lines[0].includes("Isomux Discord")).toBe(false);
  });

  it("turns a switch off and a prefix to none by removing the key, renames, and moves the route to another agent", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const pm = await spawn(o, "PM", "Casey");
    const before = dcRoute("d_1", LEGAL, helper.id, {
      prefix: "[x]",
      includeBots: true,
      react: true,
    });
    discordRoutes(o, o.morganId, [before]);
    const entry = await opened(
      o,
      asker.id,
      step("d_1", {
        prefix: "",
        includeBots: false,
        name: "Legal",
        agentId: pm.id,
      }),
    );
    expect((await apply(o, o.morgan, entry.id)).status).toBeLessThan(300);
    const after = dcRoutesOf(o, o.morganId);
    expect(after.length).toBe(1);
    expect(after[0]).toEqual({
      ...dcRoute("d_1", LEGAL, pm.id, { react: true }),
      name: "Legal",
    });
    await closesDone(o, asker.id, entry.id);
  });

  it("makes a dead route live again", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    discordRoutes(o, o.morganId, [
      dcRoute("d_1", LEGAL, helper.id, { dead: "agent_chat_only" }),
    ]);
    const entry = await opened(
      o,
      asker.id,
      step("d_1", { agentId: helper.id }),
    );
    expect((await apply(o, o.morgan, entry.id)).status).toBeLessThan(300);
    expect(dcRoutesOf(o, o.morganId)[0].dead).toBeUndefined();
    await closesDone(o, asker.id, entry.id);
  });

  it("changes only the keys of `set` on the WhatsApp row", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const group = waRow("r_1", GROUP, helper.id, { name: "Family" });
    const contact = waRow("r_2", CONTACT, helper.id, { sendDirect: true });
    whatsappRows(o, o.morganId, [group, contact]);
    const entry = await opened(
      o,
      asker.id,
      step("r_1", {
        trigger: "all",
        sendDirect: true,
        prefix: "[bot]",
        ownMessages: true,
      }),
    );
    expect((await apply(o, o.morgan, entry.id)).status).toBeLessThan(300);
    expect(waRowsOf(o, o.morganId)).toEqual([
      {
        ...group,
        trigger: "all",
        sendDirect: true,
        prefix: "[bot]",
        ownMessages: true,
      },
      contact,
    ]);
    await closesDone(o, asker.id, entry.id);

    const off = await opened(o, asker.id, step("r_2", { sendDirect: false }));
    expect((await apply(o, o.morgan, off.id)).status).toBeLessThan(300);
    expect(waRowsOf(o, o.morganId)[1]).toEqual(
      waRow("r_2", CONTACT, helper.id),
    );
    await closesDone(o, asker.id, off.id);
  });

  it("refuses Apply on a route deleted since the create: nothing written, the ask stays open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const kept = dcRoute("d_2", RANDOM, helper.id);
    discordRoutes(o, o.morganId, [dcRoute("d_1", LEGAL, helper.id), kept]);
    const entry = await opened(o, asker.id, step("d_1", { react: true }));
    const removed = await asSession(
      o,
      o.morgan,
      "DELETE",
      "/api/discord/routes/d_1",
    );
    expect(removed.status).toBeLessThan(300);
    expect((await apply(o, o.morgan, entry.id)).status).toBe(404);
    expect(dcRoutesOf(o, o.morganId)).toEqual([kept]);
    await staysOpen(o, asker.id, entry.id);
  });

  it("closes the ask when the member changes the Discord route by hand, and not on a change to another key", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    discordRoutes(o, o.morganId, [
      dcRoute("d_1", LEGAL, helper.id, { replyMode: "read" }),
    ]);
    const entry = await opened(o, asker.id, step("d_1", { replyMode: "ask" }));
    const other = await asSession(
      o,
      o.morgan,
      "PATCH",
      "/api/discord/routes/d_1",
      { react: true },
    );
    expect(other.status).toBeLessThan(300);
    await staysOpen(o, asker.id, entry.id);
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

  it("closes the ask when the member changes the WhatsApp row by hand", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    whatsappRows(o, o.morganId, [waRow("r_1", GROUP, helper.id)]);
    const entry = await opened(o, asker.id, step("r_1", { trigger: "all" }));
    const changed = await asSession(
      o,
      o.morgan,
      "PATCH",
      "/api/whatsapp/routes/r_1",
      { trigger: "all" },
    );
    expect(changed.status).toBeLessThan(300);
    await closesDone(o, asker.id, entry.id);
  });
});

describe("a messaging-route ask from /mcp", () => {
  it("open_ask keeps every key of `set`, and the server still sees a key it must refuse", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    discordRoutes(o, o.morganId, [
      dcRoute("d_1", LEGAL, helper.id, { replyMode: "read" }),
    ]);
    // /mcp takes an agent below Standard.
    const lowered = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${asker.id}/access`,
      { access: "office" },
    );
    expect(lowered.status).toBe(200);
    const client = new Client({ name: "msg-route-ask-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(asker.id)}` },
        },
      }),
    );
    clients.push(client);
    const call = async (body: Record<string, unknown>) =>
      (await client.callTool({
        name: "open_ask",
        arguments: { prompt: "Please change this route.", step: body },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };

    const set = {
      replyMode: "ask",
      trigger: "all",
      prefix: "[bot]",
      includeBots: true,
      react: true,
      name: "Legal",
      agentId: helper.id,
    };
    const result = await call(step("d_1", set));
    expect(result.isError ?? false).toBe(false);
    const entry = JSON.parse(result.content?.[0]?.text ?? "{}") as AskEntry;
    expect(entry.step as unknown).toEqual({
      kind: "messaging-route",
      app: "discord",
      routeId: "d_1",
      set,
    });
    // A key the PATCH does not take: the step opens only if /mcp drops it.
    const refused = await call(
      step("d_1", { replyMode: "ask", colour: "red" }),
    );
    expect(refused.isError ?? false).toBe(true);
    expect((await asksOf(o, o.morgan)).length).toBe(1);
  });
});
