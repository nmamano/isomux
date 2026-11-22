// "... and automate" on the server (task 33891b5b): every answer route takes
// the member's words for a rule (`automate`, "" = the agent proposes it) and
// sends them under a second note after the answer's own; the rule stage that
// follows is in ask-automate-rule.test.ts (task 1b4dfa91). The agent may
// prefill the rule on the ask (automateText). Through the routes and /mcp,
// FakeBackend only. The refusals on asks that cannot be automated, with
// nothing sent or filed, are in server/routes/handlers/asks.test.ts, where a
// messaging draft and an ask with no agent can be built.
//
// The notes come from askReplyNote, so these tests pin which note a message
// gets (its AskRef), not its words: the words are read at review.

import { describe, it, expect, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { askReplyNote, ASK_PROMPT_MAX } from "../asks.ts";
import type {
  AskClosure,
  AskEntry,
  AskMemberWire,
  AskRef,
} from "../../shared/types.ts";
import type { AskClosedWire } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

type Res = { status: number; code?: string; body: unknown };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: { bearer?: string; rawSessionId?: string },
  body?: { json?: unknown; text?: string },
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  let payload: string | undefined;
  if (body?.text !== undefined) {
    headers["Content-Type"] = "text/plain";
    payload = body.text;
  } else if (body?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  }
  const res = await srv.http(path, {
    method,
    headers,
    body: payload,
    rawSessionId: auth.rawSessionId,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    body: parsed,
  };
}

async function world() {
  server = await startTestServer({
    fakeBackend: new FakeBackend({
      storedSessionState: "durable",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    }),
  });
  const owner = await server.seedOwner("Nil");
  const ownerId = getUserByName(owner.username)!.id;
  const [room] = server.agentManager.getRooms();
  const asker = await server.agentManager.spawn(
    "Asker",
    server.workDir,
    "default",
    undefined,
    undefined,
    room.id,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
    undefined,
    ownerId,
  );
  if (!asker) throw new Error("spawn failed");
  const srv = server;
  const agent = { bearer: getAgentTokenRaw(asker.id)! };
  const member = { rawSessionId: owner.rawSessionId };
  const base = `/api/agents/${asker.id}/asks`;
  const open = async (prompt: string, json: Record<string, unknown> = {}) => {
    const r = await call(srv, "POST", base, agent, {
      json: { text: prompt, ...json },
    });
    expect(r.status).toBe(201);
    return r.body as AskEntry;
  };
  const answer = (id: string, verb: string, json: unknown = {}) =>
    call(srv, "POST", `/api/asks/${id}/${verb}`, member, { json });
  const read = async (id: string) =>
    (
      await call(srv, "GET", `${base}/${id}`, {
        bearer: getAgentTokenRaw(asker.id)!,
      })
    ).body as AskClosedWire;
  const patch = (id: string, json: unknown) =>
    call(srv, "PATCH", `${base}/${id}`, agent, { json });
  const close = async (id: string) =>
    expect((await call(srv, "DELETE", `${base}/${id}`, agent)).status).toBe(
      204,
    );
  // The ref each logged member message carries, without the session (the
  // ref names it once the agent has one).
  const loggedRefs = () =>
    srv.agentManager
      .getAgentLogs(asker.id)
      .filter((e) => e.kind === "user_message")
      .map((e) => {
        const { sessionId: _s, ...ref } = (e.metadata?.ask ?? {}) as Record<
          string,
          unknown
        >;
        return ref;
      });
  const sent = () =>
    srv.fakeBackend.sessions
      .filter((s) => s.opts.agentId === asker.id)
      .flatMap((s) => s.sent.map((m) => m.text));
  return {
    srv,
    owner,
    asker,
    agent,
    member,
    base,
    open,
    answer,
    read,
    patch,
    close,
    loggedRefs,
    sent,
  };
}

const RULE = "Tab order and copy changes: go with your pick, tell me after.";

describe("an answer with automate (task 33891b5b)", () => {
  it("adds the automate note after the answer's own note, unchanged; words and a blank get different notes", () => {
    const ref: AskRef = { id: "a1b2c3d4", prompt: "Ship the tab order?" };
    for (const flags of [
      {},
      { dismissed: true },
      { postponed: true },
      { simplify: true },
    ]) {
      const plain = askReplyNote({ ...ref, ...flags });
      const worded = askReplyNote({ ...ref, ...flags, automate: RULE });
      const blank = askReplyNote({ ...ref, ...flags, automate: "" });
      // The first note is the answer's, as an older reader knows it.
      expect([worded.startsWith(plain), blank.startsWith(plain)]).toEqual([
        true,
        true,
      ]);
      expect(new Set([plain, worded, blank]).size).toBe(3);
      expect(worded.slice(plain.length)).toContain(RULE);
    }
  });

  it("an answer without automate has no automate on the ref or the closure", async () => {
    const w = await world();
    const created = await w.open("Ship it?");
    expect((await w.answer(created.id, "reply", { text: "Yes" })).status).toBe(
      204,
    );
    await waitUntil(() => w.sent().length === 1, "delivered");
    expect("automate" in w.loggedRefs()[0]).toBe(false);
    const closed = (await w.read(created.id)).closed as AskClosure;
    expect("automate" in closed).toBe(false);
    expect(w.sent()[0]).toContain(
      askReplyNote({ id: created.id, prompt: created.prompt }),
    );
  });

  it("a rewrite with automate: one message under the rewrite note and the automate note; the ask stays open, marked; the request's event keeps the words", async () => {
    const w = await world();
    const created = await w.open("Ship the tab order?");
    const r = await w.answer(created.id, "rewrite", {
      text: "Use a picture",
      automate: RULE,
    });
    expect(r.status).toBe(204);
    await waitUntil(() => w.sent().length === 1, "delivered");
    const ref = { id: created.id, prompt: created.prompt, simplify: true };
    expect(w.loggedRefs()).toEqual([{ ...ref, automate: RULE }]);
    expect(w.sent()[0]).toBe(
      `[${w.owner.username}] ${askReplyNote({ ...ref, automate: RULE })}Use a picture`,
    );
    const open = await w.read(created.id);
    expect([
      open.closed === undefined,
      typeof open.simplifyRequestedAt,
    ]).toEqual([true, "number"]);
    await w.close(created.id);
    const events = (await w.read(created.id)).events.filter(
      (e) => e.kind === "simplify_requested",
    );
    expect(events.map((e) => ("automate" in e ? e.automate : null))).toEqual([
      RULE,
    ]);
  });

  it(`takes words up to ASK_PROMPT_MAX; longer words or a non-string are 400 invalid_automate on every route, with nothing sent or closed`, async () => {
    const w = await world();
    const created = await w.open("Rotate the key?");
    for (const verb of ["reply", "dismiss", "postpone", "rewrite"])
      for (const automate of ["x".repeat(ASK_PROMPT_MAX + 1), 5, null, ["x"]]) {
        const r = await w.answer(created.id, verb, { text: "Yes", automate });
        expect(`${verb} ${r.status} ${r.code}`).toBe(
          `${verb} 400 invalid_automate`,
        );
      }
    await sleep(50);
    expect(w.sent()).toEqual([]);
    expect(w.srv.agentManager.getTasks()).toEqual([]);
    const still = await w.read(created.id);
    expect([still.closed === undefined, still.simplifyRequestedAt]).toEqual([
      true,
      undefined,
    ]);
    const longest = "x".repeat(ASK_PROMPT_MAX);
    expect(
      (
        await w.answer(created.id, "reply", {
          text: "Yes",
          automate: longest,
        })
      ).status,
    ).toBe(204);
    await waitUntil(() => w.sent().length === 1, "delivered");
    // The ask stays open for the rule (task 1b4dfa91), with the words.
    expect((await w.read(created.id)).automateRequest?.words).toBe(longest);
  });
  it("the bare simplify alias and the rewrite's withdrawal take no automate: 400 invalid_automate, nothing sent or marked", async () => {
    const w = await world();
    const created = await w.open("Rotate the key?");
    const r = await w.answer(created.id, "simplify", { automate: RULE });
    expect([r.status, r.code]).toEqual([400, "invalid_automate"]);
    expect((await w.answer(created.id, "rewrite", {})).status).toBe(204);
    await waitUntil(() => w.sent().length === 1, "rewrite delivered");
    const undo = await w.answer(created.id, "simplify/undo", {
      automate: RULE,
    });
    expect([undo.status, undo.code]).toEqual([400, "invalid_automate"]);
    await sleep(50);
    expect(w.sent()).toHaveLength(1);
    expect(typeof (await w.read(created.id)).simplifyRequestedAt).toBe(
      "number",
    );
  });
});

describe("a rule the agent prefills (automateText, task 33891b5b)", () => {
  const listed = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (
      (await call(w.srv, "GET", "/api/asks", w.member)).body as AskMemberWire[]
    ).find((e) => e.id === id)?.automateText ?? null;

  it("is kept on create, as JSON and as text/plain, for the agent, the member and the history", async () => {
    const w = await world();
    const json = await w.open("Ship the tab order?", { automateText: RULE });
    const text = await call(
      w.srv,
      "POST",
      `${w.base}?automateText=${encodeURIComponent(RULE)}`,
      w.agent,
      { text: "Rotate the key?\n" },
    );
    expect(text.status).toBe(201);
    const textId = (text.body as AskEntry).id;
    expect([json.automateText, (text.body as AskEntry).automateText]).toEqual([
      RULE,
      RULE,
    ]);
    expect([
      (await w.read(json.id)).automateText,
      await listed(w, json.id),
      await listed(w, textId),
    ]).toEqual([RULE, RULE, RULE]);
    await w.close(json.id);
    const made = (await w.read(json.id)).events.find(
      (e) => e.kind === "created",
    ) as { ask: Partial<AskEntry> } | undefined;
    expect(made?.ask.automateText).toBe(RULE);
  });

  it("on edit: absent keeps it, a new one replaces it, '' removes it; a bad one is 422 invalid_automate and changes nothing", async () => {
    const w = await world();
    const created = await w.open("Ship it?", { automateText: RULE });
    expect((await w.patch(created.id, { text: "Ship it now?" })).status).toBe(
      200,
    );
    expect((await w.read(created.id)).automateText).toBe(RULE);
    expect(
      (await w.patch(created.id, { text: "Ship?", automateText: "Always" }))
        .status,
    ).toBe(200);
    expect((await w.read(created.id)).automateText).toBe("Always");
    for (const automateText of ["x".repeat(ASK_PROMPT_MAX + 1), 5, ["x"]]) {
      const r = await w.patch(created.id, { text: "Ship?", automateText });
      expect([r.status, r.code]).toEqual([422, "invalid_automate"]);
    }
    expect((await w.read(created.id)).automateText).toBe("Always");
    expect(
      (await w.patch(created.id, { text: "Ship?", automateText: "" })).status,
    ).toBe(200);
    expect("automateText" in (await w.read(created.id))).toBe(false);
  });

  it("refuses a bad one on create with 422 invalid_automate and makes no ask; a step ask cannot carry one", async () => {
    const w = await world();
    for (const json of [
      { automateText: "x".repeat(ASK_PROMPT_MAX + 1) },
      { automateText: 5 },
      // Only the member can do a step: nothing to automate.
      { automateText: RULE, step: { kind: "browser-pairing" } },
    ]) {
      const r = await call(w.srv, "POST", w.base, w.agent, {
        json: { text: "Pair?", ...json },
      });
      expect({ json, status: r.status, code: r.code }).toEqual({
        json,
        status: 422,
        code: "invalid_automate",
      });
    }
    expect(
      ((await call(w.srv, "GET", "/api/asks", w.member)).body as unknown[])
        .length,
    ).toBe(0);
  });

  it("is refused on an app's ask, on create and on edit (422 invalid_automate)", async () => {
    const w = await world();
    const reg = await call(
      w.srv,
      "POST",
      "/api/apps",
      { bearer: getAgentTokenRaw(w.asker.id)! },
      {
        json: {
          name: "triage-bot",
          command: "bun run serve.ts",
          cwd: w.srv.workDir,
        },
      },
    );
    expect(reg.status).toBe(201);
    const token = w.srv.appSupervisor.tokenFiles.get("triage-bot")!;
    const app = { bearer: token };
    const refusedCreate = await call(w.srv, "POST", "/api/app/asks", app, {
      json: { text: "Ship?", automateText: RULE },
    });
    expect([refusedCreate.status, refusedCreate.code]).toEqual([
      422,
      "invalid_automate",
    ]);
    const made = await call(w.srv, "POST", "/api/app/asks", app, {
      json: { text: "Ship?" },
    });
    expect(made.status).toBe(201);
    const id = (made.body as AskEntry).id;
    const refusedEdit = await call(w.srv, "PATCH", `/api/app/asks/${id}`, app, {
      json: { text: "Ship?", automateText: RULE },
    });
    expect([refusedEdit.status, refusedEdit.code]).toEqual([
      422,
      "invalid_automate",
    ]);
    expect(
      (
        (await call(w.srv, "GET", "/api/asks", w.member)).body as AskEntry[]
      ).map((e) => [e.id, e.automateText ?? null]),
    ).toEqual([[id, null]]);
  });

  it("through /mcp: open_ask and edit_ask take it", async () => {
    const w = await world();
    const access = await call(
      w.srv,
      "PUT",
      `/api/agents/${w.asker.id}/access`,
      w.member,
      { json: { access: "office" } },
    );
    expect(access.status).toBe(200);
    const client = new Client({ name: "ask-automate-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${w.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(w.asker.id)}` },
        },
      }),
    );
    clients.push(client);
    type ToolResult = {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
    };
    const tool = async <T>(name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({
        name,
        arguments: args,
      })) as ToolResult;
      const text = (r.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
      expect({ isError: !!r.isError, text }).toMatchObject({ isError: false });
      return (r.structuredContent ?? JSON.parse(text)) as T;
    };
    const made = await tool<AskEntry>("open_ask", {
      prompt: "Ship the tab order?",
      automateText: RULE,
    });
    expect((await w.read(made.id)).automateText).toBe(RULE);
    await tool("edit_ask", { askId: made.id, automateText: "Always" });
    expect((await w.read(made.id)).automateText).toBe("Always");
    await tool("edit_ask", { askId: made.id, automateText: "" });
    expect("automateText" in (await w.read(made.id))).toBe(false);
  });
});
