// The messaging rule of permission packs (task 134b8f77, part 1) through the
// real HTTP server. A sender with a pack (an agent below Standard, a limited
// API token) writes only to agents whose access fits inside that pack; it
// replies (send, abort, queue cancel) to an agent that wrote to it first; what
// it spawns or revives must fit it too. Every refusal carries the rule's code.
// Every agent below Standard holds one fixed grant (task 82da687b): agents,
// tasks and asks write, with no room limit.
// The fit table's coverage is routes-table.test.ts, the drop at a scheduled
// fire scheduled-messages.di.test.ts, the label of a fitting agent sender
// agent-sender-trust.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import {
  AGENT_SENDER_LIMITED,
  API_TOKEN_REPLIES_ONLY,
} from "../../shared/identity.ts";
import { API_TOKEN_PRESETS } from "../../shared/api-token-limits.ts";
import type { AgentInfo, TaskItem } from "../../shared/types.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";

// The error code of a refusal by the rule (a protocol value).
const NOT_FIT = "agent_does_not_fit";

let server: TestServer | null = null;
const clients: Client[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

// Each agent gets its own folder outside the office state: the folder rules
// refuse a folder that overlaps another agent's.
function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-fit-"));
  folders.push(dir);
  return dir;
}

interface Res {
  status: number;
  body: unknown;
}

const codeOf = (res: Res): string | undefined =>
  (res.body as { error?: { code?: string } } | null)?.error?.code;
const outcome = (res: Res) => ({ status: res.status, code: codeOf(res) });
const REFUSED = { status: 403, code: NOT_FIT };
const limitedOf = (task: unknown) =>
  (task as Record<string, unknown>).limited === true;

// Morgan owns the office and manages every agent. A turn ends at once, except
// for an agent in `parked`, whose turn runs until the test ends it.
async function office() {
  const parked = new Set<string>();
  const fakeBackend = new FakeBackend({
    storedSessionState: "durable",
    session: {
      onSend: (_t, _a, s) =>
        parked.has(s.opts.agentId ?? "")
          ? s.push({ kind: "assistant_text", text: "..." })
          : s.completeTurn({ text: "ok" }),
    },
  });
  const srv = await startTestServer({ fakeBackend });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const o = {
    srv,
    parked,
    session: owner.rawSessionId,
    username: owner.username,
    userId: getUserByName(owner.username)!.id,
    room: srv.agentManager.getRooms()[0].id,
  };
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function spawn(
  o: Office,
  name: string,
  opts: { room?: string; cwd?: string } = {},
): Promise<AgentInfo> {
  const agent = await o.srv.agentManager.spawn(
    name,
    opts.cwd ?? freshFolder(),
    "default",
    undefined,
    undefined,
    opts.room ?? o.room,
    undefined,
    undefined,
    undefined,
    o.username,
    "claude",
    undefined,
    o.userId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

async function asMember(
  o: Office,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await o.srv.http(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    rawSessionId: o.session,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function asBearer(
  o: Office,
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await fetch(`${o.srv.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function tokenOf(agentId: string): string {
  const token = getAgentTokenRaw(agentId);
  if (!token) throw new Error(`no live token for ${agentId}`);
  return token;
}

// The areas of the fixed grant, as token limits: a token with them fits an
// agent at Office.
const FIXED_AREAS = { agents: "write", tasks: "write", asks: "write" } as const;

// Moves an agent with the member's slider.
async function lower(
  o: Office,
  agent: AgentInfo,
  access: "chat" | "office" | "folder" | "web" | "standard",
): Promise<void> {
  const res = await asMember(o, "PUT", `/api/agents/${agent.id}/access`, {
    access,
  });
  expect({ agent: agent.name, status: res.status }).toEqual({
    agent: agent.name,
    status: 200,
  });
}

async function mint(
  o: Office,
  limits?: unknown,
): Promise<{ bearer: string; id: string }> {
  const res = await asMember(o, "POST", "/api/me/api-tokens", {
    name: "Script",
    expiresInDays: 30,
    ...(limits === undefined ? {} : { limits }),
  });
  expect(res.status).toBe(201);
  const created = res.body as ApiTokenCreateRes;
  return { bearer: created.token, id: created.apiToken.id };
}

const send = (o: Office, bearer: string, toId: string, text: string) =>
  asBearer(o, bearer, "POST", `/api/agents/${toId}/messages`, { text });

const sentTexts = (o: Office, agentId: string): string[] =>
  o.srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));

const received = (o: Office, agentId: string, text: string) =>
  sentTexts(o, agentId).find((t) => t.includes(text));

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

// The label of a message from an agent below Standard.
const limitedLabel = (senderId: string) =>
  `(agent id: ${senderId}, ${AGENT_SENDER_LIMITED})`;

// Sends `text` to each target and checks the outcome: a fit is delivered, a
// refusal carries the rule's code and leaves the target's chat empty.
async function sendEach(
  o: Office,
  bearer: string,
  cases: Array<[string, AgentInfo, boolean]>,
): Promise<void> {
  for (const [label, target, fits] of cases) {
    const res = await send(o, bearer, target.id, `to ${label}`);
    expect({ label, ...outcome(res) }).toEqual(
      fits ? { label, status: 200, code: undefined } : { label, ...REFUSED },
    );
  }
  for (const [label, target, fits] of cases) {
    if (fits)
      await waitUntil(
        () => received(o, target.id, `to ${label}`) !== undefined,
        `${label} received`,
      );
  }
  // A refused send reaches nothing, not even a later turn.
  for (const [label, target, fits] of cases) {
    if (!fits)
      expect({ label, sent: sentTexts(o, target.id) }).toEqual({
        label,
        sent: [],
      });
  }
}

describe("an agent below Standard as the sender", () => {
  it("sends only to an agent at Chat or one whose stop fits inside its own", async () => {
    const o = await office();
    const sender = await spawn(o, "Triage");
    await lower(o, sender, "office");
    const chat = await spawn(o, "Chat");
    await lower(o, chat, "chat");
    // The same fixed grant at the same stop.
    const equal = await spawn(o, "Equal");
    await lower(o, equal, "office");
    const higherStop = await spawn(o, "Higher stop");
    await lower(o, higherStop, "folder");
    const standard = await spawn(o, "Standard");

    await sendEach(o, tokenOf(sender.id), [
      ["chat", chat, true],
      ["equal", equal, true],
      ["higher stop", higherStop, false],
      ["standard", standard, false],
    ]);
    // The sender reads text from strangers: its label says so even where it
    // fits.
    for (const target of [chat, equal]) {
      expect(received(o, target.id, "to ")).toContain(limitedLabel(sender.id));
    }
  });

  it("at Folder or Web, fits no other agent at Folder or Web", async () => {
    // The folder rules let no agent's folder overlap the folder of an agent at
    // Folder or Web, so no such target sits inside the sender's folder: each
    // reads files the sender cannot.
    const o = await office();
    const sender = await spawn(o, "Reader");
    await lower(o, sender, "web");
    const office_ = await spawn(o, "Office peer");
    await lower(o, office_, "office");
    const folder = await spawn(o, "Folder peer");
    await lower(o, folder, "folder");
    const web = await spawn(o, "Web peer");
    await lower(o, web, "web");

    await sendEach(o, tokenOf(sender.id), [
      ["office", office_, true],
      ["folder", folder, false],
      ["web", web, false],
    ]);
  });

  it("is refused the same way through /mcp send_message", async () => {
    const o = await office();
    const sender = await spawn(o, "Triage");
    await lower(o, sender, "office");
    const chat = await spawn(o, "Chat");
    await lower(o, chat, "chat");
    const standard = await spawn(o, "Standard");

    const client = new Client({ name: "pack-fit-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokenOf(sender.id)}` },
        },
      }),
    );
    clients.push(client);
    const tool = async (agentId: string, text: string) => {
      const result = (await client.callTool({
        name: "send_message",
        arguments: { agentId, text },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      return {
        isError: !!result.isError,
        code: result.isError
          ? (result.content?.[0]?.text ?? "").split(":")[0]
          : undefined,
      };
    };

    expect(await tool(standard.id, "to standard")).toEqual({
      isError: true,
      code: NOT_FIT,
    });
    expect(await tool(chat.id, "to chat")).toEqual({
      isError: false,
      code: undefined,
    });
    await waitUntil(
      () => received(o, chat.id, "to chat") !== undefined,
      "chat received",
    );
    expect(sentTexts(o, standard.id)).toEqual([]);
  });
});

describe("a reply to an agent that wrote first", () => {
  it("an agent below Standard sends, aborts and cancels to the writer only, and its reply is marked limited", async () => {
    const o = await office();
    const sender = await spawn(o, "Triage");
    await lower(o, sender, "office");
    const writer = await spawn(o, "Lead");
    const bystander = await spawn(o, "Bystander");
    const bearer = tokenOf(sender.id);
    const replies = (id: string) =>
      [
        ["POST", `/api/agents/${id}/abort`, {}],
        ["DELETE", `/api/agents/${id}/queue/no-such-message`, undefined],
      ] as const;

    // Before the writer wrote: every reply route is refused by the rule.
    expect(outcome(await send(o, bearer, writer.id, "early"))).toEqual(REFUSED);
    for (const [method, path, body] of replies(writer.id)) {
      expect({
        path,
        ...outcome(await asBearer(o, bearer, method, path, body)),
      }).toEqual({ path, ...REFUSED });
    }

    expect(
      (await send(o, tokenOf(writer.id), sender.id, "please check")).status,
    ).toBe(200);
    await waitUntil(
      () => received(o, sender.id, "please check") !== undefined,
      "the question delivered",
    );

    expect((await send(o, bearer, writer.id, "checked")).status).toBe(200);
    await waitUntil(
      () => received(o, writer.id, "checked") !== undefined,
      "the reply delivered",
    );
    expect(received(o, writer.id, "checked")).toContain(
      limitedLabel(sender.id),
    );
    // An idle agent has no turn to stop and no such message: any answer but
    // a refusal.
    for (const [method, path, body] of replies(writer.id)) {
      const res = await asBearer(o, bearer, method, path, body);
      expect({ path, refused: res.status === 403 }).toEqual({
        path,
        refused: false,
      });
    }
    // Another agent did not write: still refused.
    expect(outcome(await send(o, bearer, bystander.id, "hi"))).toEqual(REFUSED);
  });

  it("comes at delivery: a message taken back before it reached the agent gives none", async () => {
    const o = await office();
    const sender = await spawn(o, "Triage");
    await lower(o, sender, "office");
    const writer = await spawn(o, "Lead");

    // The member starts a long turn, so the writer's message waits.
    o.parked.add(sender.id);
    expect(
      (
        await asMember(o, "POST", `/api/agents/${sender.id}/messages`, {
          text: "start a long job",
        })
      ).status,
    ).toBe(200);
    await waitUntil(
      () => sentTexts(o, sender.id).length === 1,
      "the job started",
    );
    const queued = await send(o, tokenOf(writer.id), sender.id, "never mind");
    expect(queued.body).toMatchObject({ queued: true });
    const messageId = (queued.body as { messageId: string }).messageId;
    expect(
      (
        await asBearer(
          o,
          tokenOf(writer.id),
          "DELETE",
          `/api/agents/${sender.id}/queue/${messageId}`,
        )
      ).status,
    ).toBe(204);
    o.parked.delete(sender.id);
    o.srv.fakeBackend
      .sessionForAgent(sender.id)!
      .completeTurn({ text: "done" });

    expect(
      outcome(await send(o, tokenOf(sender.id), writer.id, "anything?")),
    ).toEqual(REFUSED);

    // The same message delivered does give the reply.
    expect(
      (await send(o, tokenOf(writer.id), sender.id, "now for real")).status,
    ).toBe(200);
    await waitUntil(
      () => received(o, sender.id, "now for real") !== undefined,
      "the message delivered",
    );
    expect(
      (await send(o, tokenOf(sender.id), writer.id, "answer")).status,
    ).toBe(200);
  });

  it("survives a restart, and ends when the writer is killed", async () => {
    const o = await office();
    const sender = await spawn(o, "Triage");
    await lower(o, sender, "office");
    const writer = await spawn(o, "Lead");
    expect(
      (await send(o, tokenOf(writer.id), sender.id, "please check")).status,
    ).toBe(200);
    await waitUntil(
      () => received(o, sender.id, "please check") !== undefined,
      "the question delivered",
    );

    o.srv = await o.srv.restart();
    server = o.srv;
    expect(
      (await send(o, tokenOf(sender.id), writer.id, "after the restart"))
        .status,
    ).toBe(200);

    // The kill drops the pair, and a restart before the revive does not
    // bring it back.
    expect(
      (await asMember(o, "DELETE", `/api/agents/${writer.id}`)).status,
    ).toBe(204);
    o.srv = await o.srv.restart();
    server = o.srv;
    expect(
      (
        await asMember(o, "POST", `/api/agents/${writer.id}/revive`, {
          roomId: o.room,
        })
      ).status,
    ).toBe(200);
    expect(
      outcome(await send(o, tokenOf(sender.id), writer.id, "still there?")),
    ).toEqual(REFUSED);
  });

  it("ends when the agent that may reply is killed", async () => {
    const o = await office();
    const sender = await spawn(o, "Triage");
    await lower(o, sender, "office");
    const writer = await spawn(o, "Lead");
    expect(
      (await send(o, tokenOf(writer.id), sender.id, "please check")).status,
    ).toBe(200);
    await waitUntil(
      () => received(o, sender.id, "please check") !== undefined,
      "the question delivered",
    );
    expect(
      (await asMember(o, "DELETE", `/api/agents/${sender.id}`)).status,
    ).toBe(204);
    expect(
      (
        await asMember(o, "POST", `/api/agents/${sender.id}/revive`, {
          roomId: o.room,
        })
      ).status,
    ).toBe(200);
    expect(
      outcome(await send(o, tokenOf(sender.id), writer.id, "back again")),
    ).toEqual(REFUSED);
  });
});

describe("a limited API token as the sender", () => {
  // An agent at Office holds agents, tasks and asks write: a token fits it
  // only with all three. The talk-to-agents preset has tasks read only.
  it("sends only to an agent at Chat or Office whose grant fits inside its areas, without a marker", async () => {
    const o = await office();
    const fixed = await mint(o, { areas: FIXED_AREAS });
    const talk = await mint(o, API_TOKEN_PRESETS.talkToAgents);
    const chat = await spawn(o, "Chat");
    await lower(o, chat, "chat");
    const atOffice = await spawn(o, "At office");
    await lower(o, atOffice, "office");
    // A token reaches no folder: Office is its highest stop.
    const folder = await spawn(o, "Folder");
    await lower(o, folder, "folder");
    const standard = await spawn(o, "Standard");

    await sendEach(o, fixed.bearer, [
      ["chat", chat, true],
      ["office", atOffice, true],
      ["folder", folder, false],
      ["standard", standard, false],
    ]);
    // A message that fits keeps the member's authority.
    const label = received(o, atOffice.id, "to office")!;
    expect(label).toContain(`(${fixed.id})`);
    expect(label).not.toContain(API_TOKEN_REPLIES_ONLY);

    // Tasks read is narrower than the agent's tasks write.
    expect(
      outcome(await send(o, talk.bearer, atOffice.id, "from talk")),
    ).toEqual(REFUSED);
    expect((await send(o, talk.bearer, chat.id, "from talk")).status).toBe(200);
  });

  it("is outside the rule when its pack already reaches everything", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const talk = API_TOKEN_PRESETS.talkToAgents.areas;
    const cases: Array<[string, unknown, boolean]> = [
      ["no limits", undefined, true],
      ["rooms only", { rooms: [o.room] }, true],
      ["memory write", { areas: { ...talk, memory: "write" } }, true],
      ["files write", { areas: { ...talk, files: "write" } }, true],
      // Agents, agentManagement and asks write are what the rule bounds.
      [
        "agents, agentManagement and asks write",
        {
          areas: {
            ...talk,
            agentManagement: "write",
            asks: "write",
          },
        },
        false,
      ],
    ];
    for (const [label, limits, reaches] of cases) {
      const token = await mint(o, limits);
      const res = await send(o, token.bearer, standard.id, `from ${label}`);
      expect({ label, ...outcome(res) }).toEqual(
        reaches
          ? { label, status: 200, code: undefined }
          : { label, ...REFUSED },
      );
    }
  });

  it("replies to an agent that wrote to its inbox, marked replies only, and gives it no order", async () => {
    const o = await office();
    const talk = await mint(o, API_TOKEN_PRESETS.talkToAgents);
    const full = await mint(o);
    const writer = await spawn(o, "Lead");
    const spare = await spawn(o, "Spare");
    expect(
      (
        await asBearer(
          o,
          tokenOf(writer.id),
          "POST",
          `/api/api-token-inboxes/${talk.id}/messages`,
          { text: "result" },
        )
      ).status,
    ).toBe(200);

    expect((await send(o, talk.bearer, writer.id, "thanks")).status).toBe(200);
    await waitUntil(
      () => received(o, writer.id, "thanks") !== undefined,
      "the reply delivered",
    );
    expect(received(o, writer.id, "thanks")).toContain(
      `(${talk.id}, ${API_TOKEN_REPLIES_ONLY})`,
    );

    // Orders, not replies: refused by the rule even to the writer. A token
    // outside the rule passes the same route, so the rule is the reason.
    const orders: Array<[string, (id: string) => string, unknown]> = [
      ["POST", (id) => `/api/agents/${id}/new-conversation`, {}],
      ["POST", (id) => `/api/agents/${id}/handoff`, { text: "carry on" }],
      ["POST", (id) => `/api/agents/${id}/send-now`, {}],
      ["PATCH", (id) => `/api/agents/${id}/messages/no-such-entry`, {}],
      [
        "POST",
        (id) => `/api/agents/${id}/interactions/no-such-prompt/respond`,
        { value: "1" },
      ],
    ];
    for (const [method, path, body] of orders) {
      const refused = await asBearer(
        o,
        talk.bearer,
        method,
        path(writer.id),
        body,
      );
      expect({ path: path(writer.id), ...outcome(refused) }).toEqual({
        path: path(writer.id),
        ...REFUSED,
      });
      const open = await asBearer(o, full.bearer, method, path(spare.id), body);
      expect({ path: path(spare.id), refused: open.status === 403 }).toEqual({
        path: path(spare.id),
        refused: false,
      });
    }
  });
});

describe("the outbox of scheduled messages", () => {
  it("a limited token cancels only in the outbox of an agent that fits it; an agent at Folder still cancels in its own", async () => {
    const o = await office();
    const talk = await mint(o, { areas: FIXED_AREAS });
    const receiver = await spawn(o, "Receiver");
    await lower(o, receiver, "chat");
    const standard = await spawn(o, "Standard");
    const fitting = await spawn(o, "Fitting");
    await lower(o, fitting, "office");
    // An agent at Folder fits no agent at Folder, itself included: only its
    // own outbox lets it in.
    const folder = await spawn(o, "Folder");
    await lower(o, folder, "folder");
    const deliverAt = new Date(Date.now() + 3_600_000).toISOString();
    const schedule = async (from: AgentInfo): Promise<string> => {
      const res = await asBearer(
        o,
        tokenOf(from.id),
        "POST",
        `/api/agents/${receiver.id}/messages`,
        { text: `later from ${from.name}`, deliverAt },
      );
      expect({ from: from.name, status: res.status }).toEqual({
        from: from.name,
        status: 200,
      });
      return (res.body as { scheduledId: string }).scheduledId;
    };
    const outbox = async (agent: AgentInfo): Promise<string[]> => {
      const res = await asBearer(
        o,
        tokenOf(agent.id),
        "GET",
        `/api/agents/${agent.id}/scheduled-messages`,
      );
      expect(res.status).toBe(200);
      return (res.body as { scheduled: Array<{ id: string }> }).scheduled.map(
        (e) => e.id,
      );
    };
    const cancel = (bearer: string, agent: AgentInfo, id: string) =>
      asBearer(
        o,
        bearer,
        "DELETE",
        `/api/agents/${agent.id}/scheduled-messages/${id}`,
      );
    const fromStandard = [await schedule(standard), await schedule(standard)];
    const fromFitting = await schedule(fitting);
    const fromFolder = await schedule(folder);

    expect(
      outcome(await cancel(talk.bearer, standard, fromStandard[0])),
    ).toEqual(REFUSED);
    expect(outcome(await cancel(talk.bearer, folder, fromFolder))).toEqual(
      REFUSED,
    );
    expect(await outbox(standard)).toEqual(fromStandard);
    expect(await outbox(folder)).toEqual([fromFolder]);

    expect((await cancel(talk.bearer, fitting, fromFitting)).status).toBe(204);
    expect(await outbox(fitting)).toEqual([]);
    // Each agent still cancels in its own outbox.
    expect((await cancel(tokenOf(folder.id), folder, fromFolder)).status).toBe(
      204,
    );
    expect(
      (await cancel(tokenOf(standard.id), standard, fromStandard[0])).status,
    ).toBe(204);
    expect(await outbox(folder)).toEqual([]);
    expect(await outbox(standard)).toEqual([fromStandard[1]]);
  });
});

describe("what a sender with a pack spawns or revives", () => {
  it("a token spawns only an agent that fits it, and nothing is left of a refusal", async () => {
    const o = await office();
    const narrow = await mint(o, {
      areas: { agents: "write", agentManagement: "write" },
    });
    const wide = await mint(o, {
      areas: { ...FIXED_AREAS, agentManagement: "write" },
    });
    // The agent at Office gets the fixed grant: wider than the narrow token.
    const cases: Array<[string, string, Record<string, unknown>, boolean]> = [
      ["standard", narrow.bearer, {}, false],
      ["office narrow", narrow.bearer, { access: "office" }, false],
      ["office wide", wide.bearer, { access: "office" }, true],
      ["chat", narrow.bearer, { access: "chat" }, true],
    ];
    for (const [name, bearer, fields, fits] of cases) {
      const res = await asBearer(o, bearer, "POST", "/api/agents", {
        name,
        cwd: freshFolder(),
        roomId: o.room,
        agentType: "claude",
        ...fields,
      });
      expect({ name, ...outcome(res) }).toEqual(
        fits ? { name, status: 201, code: undefined } : { name, ...REFUSED },
      );
      expect({
        name,
        made: o.srv.agentManager.getAllAgents().some((a) => a.name === name),
      }).toEqual({ name, made: fits });
    }
  });

  // The fixed grant has no agentManagement: an agent below Standard spawns
  // nothing, an agent at Chat included.
  it("an agent below Standard spawns no agent", async () => {
    const o = await office();
    const sender = await spawn(o, "Dispatcher");
    await lower(o, sender, "office");
    for (const [name, fields] of [
      ["standard child", {}],
      ["chat child", { access: "chat" }],
    ] as const) {
      const cwd = join(sender.cwd, name.replace(" ", "-"));
      mkdirSync(cwd);
      const res = await asBearer(o, tokenOf(sender.id), "POST", "/api/agents", {
        name,
        cwd,
        roomId: o.room,
        agentType: "claude",
        ...fields,
      });
      expect({ name, status: res.status }).toEqual({ name, status: 403 });
      expect({
        name,
        made: o.srv.agentManager.getAllAgents().some((a) => a.name === name),
      }).toEqual({ name, made: false });
    }
  });

  it("a token revives only an agent that fits it", async () => {
    const o = await office();
    const token = await mint(o, {
      areas: { ...FIXED_AREAS, agentManagement: "write" },
    });
    const standard = await spawn(o, "Standard");
    const fitting = await spawn(o, "Fitting");
    await lower(o, fitting, "office");
    for (const agent of [standard, fitting]) {
      expect(
        (await asMember(o, "DELETE", `/api/agents/${agent.id}`)).status,
      ).toBe(204);
    }
    const revive = (agent: AgentInfo) =>
      asBearer(o, token.bearer, "POST", `/api/agents/${agent.id}/revive`, {
        roomId: o.room,
      });
    expect(outcome(await revive(standard))).toEqual(REFUSED);
    expect(
      o.srv.agentManager.getAllAgents().some((a) => a.id === standard.id),
    ).toBe(false);
    expect((await revive(fitting)).status).toBe(200);
    expect(
      o.srv.agentManager.getAllAgents().some((a) => a.id === fitting.id),
    ).toBe(true);
  });
});

describe("a scheduled message from an agent below Standard", () => {
  it("is refused at scheduling when it does not fit, and at delivery once the target moved up", async () => {
    const o = await office();
    const sender = await spawn(o, "Triage");
    await lower(o, sender, "office");
    const target = await spawn(o, "Target");
    await lower(o, target, "office");
    const standard = await spawn(o, "Standard");
    const deliverAt = new Date(Date.now() + 3_600_000).toISOString();
    const schedule = (toId: string) =>
      asBearer(o, tokenOf(sender.id), "POST", `/api/agents/${toId}/messages`, {
        text: "later",
        deliverAt,
      });

    expect(outcome(await schedule(standard.id))).toEqual(REFUSED);
    expect((await schedule(target.id)).status).toBe(200);

    // The member moves the target up before the fire. The fire enqueues the
    // entry as the agent's message (scheduled-messages.ts tick).
    await lower(o, target, "standard");
    const fired = o.srv.agentManager.enqueueMessage(target.id, {
      sender: {
        kind: "agent",
        agentId: sender.id,
        agentName: sender.name,
        roomName: "Room",
      },
      text: "later",
      scheduledFor: Date.now() - 1_000,
    });
    expect(fired).toMatchObject({ ok: false, status: 403 });
    // And at once: the enqueue to the agent at Office before the move.
    await Bun.sleep(50);
    expect(sentTexts(o, target.id)).toEqual([]);
  });
});

describe("tasks and asks from a limited API token", () => {
  it("a task it creates or edits is marked limited", async () => {
    const o = await office();
    const token = await mint(o, { areas: { tasks: "write" } });
    const full = await mint(o);
    const created = await asBearer(o, token.bearer, "POST", "/api/tasks", {
      title: "From the contractor",
    });
    expect(created.status).toBe(201);
    expect(limitedOf(created.body)).toBe(true);

    const memberTask = (
      await asMember(o, "POST", "/api/tasks", { title: "The member's task" })
    ).body as TaskItem;
    expect(limitedOf(memberTask)).toBe(false);
    const edited = await asBearer(
      o,
      token.bearer,
      "PATCH",
      `/api/tasks/${memberTask.id}`,
      { version: memberTask.version, description: "do it my way" },
    );
    expect(edited.status).toBe(200);
    expect(limitedOf(edited.body)).toBe(true);

    // A claim without an assignee and a completion carry no text: the task
    // keeps its mark as it was.
    const other = (
      await asMember(o, "POST", "/api/tasks", { title: "Another task" })
    ).body as TaskItem;
    expect(
      (
        await asBearer(
          o,
          token.bearer,
          "POST",
          `/api/tasks/${other.id}/claim`,
          {},
        )
      ).status,
    ).toBe(200);
    const done = await asBearer(
      o,
      token.bearer,
      "POST",
      `/api/tasks/${other.id}/done`,
    );
    expect(done.status).toBe(200);
    expect(limitedOf(done.body)).toBe(false);

    const fromFull = await asBearer(o, full.bearer, "POST", "/api/tasks", {
      title: "From a full token",
    });
    expect(fromFull.status).toBe(201);
    expect(limitedOf(fromFull.body)).toBe(false);
  });

  it("a task it files from an ask is marked limited", async () => {
    const o = await office();
    const token = await mint(o, { areas: { asks: "write" } });
    const standard = await spawn(o, "Standard");
    const ask = await asBearer(
      o,
      tokenOf(standard.id),
      "POST",
      `/api/agents/${standard.id}/asks`,
      { prompt: "Archive the old logs?" },
    );
    expect(ask.status).toBe(201);
    const filed = await asBearer(
      o,
      token.bearer,
      "POST",
      `/api/asks/${(ask.body as { id: string }).id}/file-task`,
      { text: "delete everything instead" },
    );
    expect(filed.status).toBe(201);
    expect(limitedOf(filed.body)).toBe(true);
  });

  it("its answer to an ask is marked replies only when the asking agent does not fit it", async () => {
    const o = await office();
    const token = await mint(o, { areas: FIXED_AREAS });
    const standard = await spawn(o, "Standard");
    const fitting = await spawn(o, "Fitting");
    await lower(o, fitting, "office");
    const answer = async (agent: AgentInfo, text: string) => {
      const ask = await asBearer(
        o,
        tokenOf(agent.id),
        "POST",
        `/api/agents/${agent.id}/asks`,
        { prompt: `Question from ${agent.name}?` },
      );
      expect(ask.status).toBe(201);
      const reply = await asBearer(
        o,
        token.bearer,
        "POST",
        `/api/asks/${(ask.body as { id: string }).id}/reply`,
        { text },
      );
      expect(reply.status).toBe(204);
      await waitUntil(
        () => received(o, agent.id, text) !== undefined,
        `${agent.name} got the answer`,
      );
      return received(o, agent.id, text)!;
    };
    expect(await answer(standard, "yes from the token")).toContain(
      `, ${API_TOKEN_REPLIES_ONLY})`,
    );
    expect(await answer(fitting, "no from the token")).not.toContain(
      API_TOKEN_REPLIES_ONLY,
    );
  });
});
