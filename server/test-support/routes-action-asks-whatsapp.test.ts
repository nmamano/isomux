// A WhatsApp route ask (task 0b53ff37), through the real server: an agent
// asks the member to route one of their WhatsApp chats to an agent, by a
// name to match, since an agent cannot read the member's chats. The member
// picks the chat on the card and Apply sends it (POST /api/asks/:id/action
// with {chat}). The run adds a row for a chat with none and moves a row that
// goes elsewhere; the step's settings are the whole state, so what it leaves
// out is the default. The ask closes when the chat goes to the agent with
// those settings, by the card or by the Integrations page.
//
// Seam: startTestServer(). A link file written after boot links the member
// with no bridge, and the supervisor's chatsSeen is stubbed: the seen list
// lives in the bridge's memory.

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
import { writeLink } from "../whatsapp/store.ts";
import { readRoutes, writeRoutes } from "../whatsapp/routes-store.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";
import type { WhatsAppChatSeen, WhatsAppRoute } from "../../shared/whatsapp.ts";

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

const PHONE = "447700900111";
const GROUP = "120363000000000001@g.us";
const OTHER_GROUP = "120363000000000002@g.us";
const CONTACT = "447700900123@s.whatsapp.net";

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
  const cwd = mkdtempSync(join(tmpdir(), "wa-route-ask-"));
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

// The member linked, with these rows; the bridge saw these chats.
function link(
  o: Office,
  userId: string,
  seen: WhatsAppChatSeen[] = [],
  routes: WhatsAppRoute[] = [],
) {
  writeLink(o.srv.stateRoot, userId, { phone: PHONE, linkedAt: Date.now() });
  writeRoutes(o.srv.stateRoot, userId, { phone: PHONE, routes });
  const spy = spyOn(whatsappSupervisor, "chatsSeen").mockImplementation(
    (id: string) => (id === userId ? seen : []),
  );
  spies.push(spy);
}

const rowsOf = (o: Office, userId: string) =>
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

const routeStep = (
  agentId: string,
  chatName: string,
  extra: Record<string, unknown> = {},
) => ({ kind: "whatsapp-route", chatName, agentId, ...extra });

function ask(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
): Promise<Res> {
  return asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Please route this chat.",
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

// The step lines in the agent's chat, as JSON.
const stepLines = (o: Office, agentId: string) =>
  o.srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => JSON.stringify(e))
    .filter((json) => /systemEntries\.stepAsk\.\w+/.test(json));

const row = (
  id: string,
  chat: string,
  name: string,
  agentId: string,
  extra: Partial<WhatsAppRoute> = {},
): WhatsAppRoute => ({
  id,
  chat,
  group: chat.endsWith("@g.us"),
  name,
  agentId,
  ...(chat.endsWith("@g.us") ? { trigger: "mention" as const } : {}),
  createdAt: 1,
  ...extra,
});

// The fields of a row that the step sets, with the defaults left out.
const settingsOf = (r: WhatsAppRoute | undefined) =>
  r && {
    agentId: r.agentId,
    trigger: r.trigger,
    sendDirect: r.sendDirect,
    prefix: r.prefix,
    ownMessages: r.ownMessages,
  };

const SEEN: WhatsAppChatSeen[] = [
  { chat: GROUP, name: "Akido Legal Team", group: true },
  { chat: OTHER_GROUP, name: "Book club", group: true },
  { chat: CONTACT, name: "Mom", group: false },
];

describe("a whatsapp-route ask at create", () => {
  it("opens for the member with the step as sent, no link, and nothing written; an owner may route to another member's agent", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const pm = await spawn(o, "PM", "Casey");
    link(o, o.morganId, SEEN);
    const entry = await opened(
      o,
      asker.id,
      routeStep(pm.id, "akido", { trigger: "all" }),
    );
    expect([entry.step, entry.link]).toEqual([
      {
        kind: "whatsapp-route",
        chatName: "akido",
        agentId: pm.id,
        trigger: "all",
      },
      undefined,
    ]);
    expect(rowsOf(o, o.morganId)).toEqual([]);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("refuses a step that is not well formed: 400 invalid_request, nothing opened", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Helper");
    link(o, o.morganId, SEEN);
    for (const step of [
      routeStep(target.id, ""),
      routeStep(target.id, "   "),
      routeStep(target.id, "Akido\nLegal"),
      routeStep(target.id, "x".repeat(61)),
      { kind: "whatsapp-route", agentId: target.id },
      { kind: "whatsapp-route", chatName: "Akido" },
      routeStep(target.id, "Akido", { chat: GROUP }),
      routeStep(target.id, "Akido", { trigger: "everything" }),
      routeStep(target.id, "Akido", { sendDirect: "yes" }),
      routeStep(target.id, "Akido", { ownMessages: 1 }),
      routeStep(target.id, "Akido", { prefix: "x".repeat(41) }),
    ])
      expect({ step, ...outcome(await ask(o, asker.id, step)) }).toEqual({
        step,
        status: 400,
        code: "invalid_request",
      });
    const asks = await asSession(o, o.morgan, "GET", "/api/asks");
    expect((asks.body as unknown[]).length).toBe(0);
  });

  it("refuses with one code per reason: no link, an agent out of reach, an agent the member may not route to, an agent at Chat stop, a step already done", async () => {
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

    // Morgan is not linked yet.
    expect(
      outcome(await ask(o, asker.id, routeStep(helper.id, "Akido"))),
    ).toEqual({ status: 409, code: "whatsapp_not_linked" });

    link(o, o.morganId, SEEN, [row("r1", GROUP, "Akido", helper.id)]);
    writeLink(o.srv.stateRoot, o.caseyId, {
      phone: "447700900222",
      linkedAt: Date.now(),
    });
    writeRoutes(o.srv.stateRoot, o.caseyId, {
      phone: "447700900222",
      routes: [],
    });

    // Casey's agent cannot reach the back room: the same answer as no agent.
    for (const agentId of ["agent-none", away.id])
      expect(
        outcome(await ask(o, caseyAsker.id, routeStep(agentId, "Akido"))),
      ).toEqual({ status: 422, code: "unknown_agent" });
    // Casey is no owner, and Helper is Morgan's.
    expect(
      outcome(await ask(o, caseyAsker.id, routeStep(helper.id, "Akido"))),
    ).toEqual({ status: 403, code: "member_not_allowed" });
    expect(
      outcome(await ask(o, asker.id, routeStep(chatOnly.id, "Akido"))),
    ).toEqual({ status: 422, code: "agent_chat_only" });
    // r1 already sends Akido to Helper, as drafts, on a mention.
    expect(
      outcome(await ask(o, asker.id, routeStep(helper.id, "akido"))),
    ).toEqual({ status: 409, code: "step_done" });
    const asks = await asSession(o, o.morgan, "GET", "/api/asks");
    expect((asks.body as unknown[]).length).toBe(0);
  });

  it("is not done while the matching row has other settings than the step: the step's settings are the whole state", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    link(o, o.morganId, SEEN, [
      row("r1", GROUP, "Akido", helper.id, { sendDirect: true }),
    ]);
    // Drafts asked; the row sends at once.
    await opened(o, asker.id, routeStep(helper.id, "Akido"));
    // A trigger asked; the row waits for a mention.
    await opened(
      o,
      asker.id,
      routeStep(helper.id, "Akido", { trigger: "all", sendDirect: true }),
    );
    // The same settings as the row: done.
    expect(
      outcome(
        await ask(
          o,
          asker.id,
          routeStep(helper.id, "Akido", { sendDirect: true }),
        ),
      ),
    ).toEqual({ status: 409, code: "step_done" });
  });
});

describe("a whatsapp-route ask at run", () => {
  it("adds a row for the picked chat with the default settings, to another member's agent, and closes the ask as done with a line that names only the asked name", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const pm = await spawn(o, "PM", "Casey");
    link(o, o.morganId, SEEN);
    const entry = await opened(o, asker.id, routeStep(pm.id, "akido"));

    const ran = await apply(o, o.morgan, entry.id, { chat: GROUP });
    expect(ran.status).toBeLessThan(300);
    const rows = rowsOf(o, o.morganId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      chat: GROUP,
      group: true,
      name: "Akido Legal Team",
      agentId: pm.id,
      trigger: "mention",
    });
    expect(settingsOf(rows[0])).toEqual({
      agentId: pm.id,
      trigger: "mention",
      sendDirect: undefined,
      prefix: undefined,
      ownMessages: undefined,
    });
    expect(rows[0].dead).toBeUndefined();
    await waitUntil(
      async () => (await askStatus(o, asker.id, entry.id)) === "done",
      "the ask closes as done",
    );
    const lines = stepLines(o, asker.id);
    expect(lines.length).toBe(1);
    // The agent learns no chat name it did not give.
    expect(lines[0].includes("Legal")).toBe(false);
    // The member's Integrations list shows the row live.
    const listed = await asSession(o, o.morgan, "GET", "/api/whatsapp/routes");
    expect(
      (listed.body as WhatsAppRoute[]).map((r) => [r.agentId, r.dead ?? null]),
    ).toEqual([[pm.id, null]]);
  });

  it("sets each setting the step names", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    link(o, o.morganId, SEEN);
    const entry = await opened(
      o,
      asker.id,
      routeStep(helper.id, "Akido", {
        trigger: "all",
        sendDirect: true,
        prefix: "[bot]",
        ownMessages: true,
      }),
    );
    expect(
      (await apply(o, o.morgan, entry.id, { chat: GROUP })).status,
    ).toBeLessThan(300);
    expect(settingsOf(rowsOf(o, o.morganId)[0])).toEqual({
      agentId: helper.id,
      trigger: "all",
      sendDirect: true,
      prefix: "[bot]",
      ownMessages: true,
    });
    await waitUntil(
      async () => (await askStatus(o, asker.id, entry.id)) === "done",
      "the ask closes as done",
    );
  });

  it("drops the trigger when the picked chat is a contact", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    link(o, o.morganId, SEEN);
    const entry = await opened(
      o,
      asker.id,
      routeStep(helper.id, "mom", { trigger: "all" }),
    );
    expect(
      (await apply(o, o.morgan, entry.id, { chat: CONTACT })).status,
    ).toBeLessThan(300);
    const rows = rowsOf(o, o.morganId);
    expect(rows.map((r) => [r.chat, r.group, r.trigger ?? null])).toEqual([
      [CONTACT, false, null],
    ]);
    await waitUntil(
      async () => (await askStatus(o, asker.id, entry.id)) === "done",
      "the ask closes as done",
    );
  });

  it("moves a row that goes to another agent: the same row, the member's name kept, the step's settings and no others", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const pm = await spawn(o, "PM", "Casey");
    link(o, o.morganId, SEEN, [
      row("r1", GROUP, "My Akido", helper.id, {
        trigger: "all",
        sendDirect: true,
        prefix: "[x]",
        ownMessages: true,
      }),
      row("r2", CONTACT, "Mom", helper.id),
    ]);
    const entry = await opened(o, asker.id, routeStep(pm.id, "akido"));
    expect(
      (await apply(o, o.morgan, entry.id, { chat: GROUP })).status,
    ).toBeLessThan(300);
    const rows = rowsOf(o, o.morganId);
    expect(rows.map((r) => [r.id, r.chat, r.name])).toEqual([
      ["r1", GROUP, "My Akido"],
      ["r2", CONTACT, "Mom"],
    ]);
    expect(settingsOf(rows[0])).toEqual({
      agentId: pm.id,
      trigger: "mention",
      sendDirect: undefined,
      prefix: undefined,
      ownMessages: undefined,
    });
    expect(settingsOf(rows[1])?.agentId).toBe(helper.id);
    await waitUntil(
      async () => (await askStatus(o, asker.id, entry.id)) === "done",
      "the ask closes as done",
    );
  });

  it("takes a chat that has a row but is not in the seen list (after a restart), matched by the row's name", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const pm = await spawn(o, "PM", "Casey");
    link(o, o.morganId, [], [row("r1", GROUP, "Akido group", helper.id)]);
    const entry = await opened(o, asker.id, routeStep(pm.id, "akido"));
    expect(
      (await apply(o, o.morgan, entry.id, { chat: GROUP })).status,
    ).toBeLessThan(300);
    expect(rowsOf(o, o.morganId).map((r) => [r.id, r.agentId])).toEqual([
      ["r1", pm.id],
    ]);
  });

  it("names a new row by the seen name cut to the row name's length", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    const long = `Akido ${"x".repeat(90)}`;
    link(o, o.morganId, [{ chat: GROUP, name: long, group: true }]);
    const entry = await opened(o, asker.id, routeStep(helper.id, "akido"));
    expect(
      (await apply(o, o.morgan, entry.id, { chat: GROUP })).status,
    ).toBeLessThan(300);
    const rows = rowsOf(o, o.morganId);
    expect(rows.length).toBe(1);
    expect(long.startsWith(rows[0].name)).toBe(true);
    expect([...rows[0].name].length).toBe(60);
  });

  it("refuses a run with no pick (400) and a pick that does not match or is not a chat of the member (409), and writes nothing", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    link(o, o.morganId, SEEN);
    const entry = await opened(o, asker.id, routeStep(helper.id, "akido"));
    for (const body of [undefined, {}, { chat: 7 }, { chat: "" }])
      expect({
        body,
        ...outcome(await apply(o, o.morgan, entry.id, body)),
      }).toEqual({
        body,
        status: 400,
        code: "invalid_request",
      });
    // Book club is the member's, but not an Akido chat; the other is no chat
    // the member's WhatsApp saw.
    for (const chat of [OTHER_GROUP, "120363000000000009@g.us"])
      expect({
        chat,
        ...outcome(await apply(o, o.morgan, entry.id, { chat })),
      }).toEqual({
        chat,
        status: 409,
        code: "chat_not_matching",
      });
    expect(rowsOf(o, o.morganId)).toEqual([]);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("closes the ask when the member adds the row on the Integrations page", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    link(o, o.morganId, SEEN);
    const entry = await opened(o, asker.id, routeStep(helper.id, "akido"));
    const added = await asSession(o, o.morgan, "POST", "/api/whatsapp/routes", {
      chat: GROUP,
      name: "Akido",
      agentId: helper.id,
    });
    expect(added.status).toBeLessThan(300);
    await waitUntil(
      async () => (await askStatus(o, asker.id, entry.id)) === "done",
      "the ask closes as done",
    );
  });
});

describe("a whatsapp-route ask from /mcp", () => {
  it("open_ask keeps every field of the step", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const helper = await spawn(o, "Helper");
    link(o, o.morganId, SEEN);
    // /mcp takes an agent below Standard.
    const lowered = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${asker.id}/access`,
      { access: "office" },
    );
    expect(lowered.status).toBe(200);
    const client = new Client({ name: "wa-route-ask-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(asker.id)}` },
        },
      }),
    );
    clients.push(client);
    const step = routeStep(helper.id, "Akido", {
      trigger: "all",
      sendDirect: true,
      prefix: "[bot]",
      ownMessages: true,
    });
    const result = (await client.callTool({
      name: "open_ask",
      arguments: { prompt: "Please route this chat.", step },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError ?? false).toBe(false);
    const entry = JSON.parse(result.content?.[0]?.text ?? "{}") as AskEntry;
    expect(entry.step as unknown).toEqual(step);
  });
});
