// The ask card's built-in answers on the server (task 1466ea8b): a rewrite
// request with the member's words (POST /rewrite; /simplify stays its bare
// alias), a postpone that closes the ask with outcome postponed, and a tag the
// agent recommends on create and edit, through the routes and through /mcp.
// FakeBackend only.
//
// The note in front of each message comes from askReplyNote, so these tests
// pin which note a message gets (its AskRef), not its words: the words are
// read at review.

import { describe, it, expect, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { askReplyNote, ASK_PROMPT_MAX } from "../asks.ts";
import {
  ASK_POSTPONED_TEXT,
  ASK_SIMPLIFY_TEXT,
  type AskEntry,
  type AskMemberWire,
} from "../../shared/types.ts";
import type {
  AskAgentWire,
  AskClosedWire,
} from "../../shared/contract-shapes.ts";

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

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
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
  // The agent's current token: a new access level mints a new one.
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
  const logged = () =>
    srv.agentManager
      .getAgentLogs(asker.id)
      .filter((e) => e.kind === "user_message")
      .map((e) => ({ content: e.content, ask: e.metadata?.ask }));
  const sent = () => sentTexts(srv, asker.id);
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
    logged,
    sent,
  };
}

describe("a rewrite request (task 1466ea8b)", () => {
  it("sends the member's words under the simplify note and marks the ask; blank words are a bare simplify; /simplify stays the bare alias; the history keeps the words", async () => {
    const w = await world();
    const created = await w.open("Merge t-1 after the CI on f00d?");
    const note = `[${w.owner.username}] ${askReplyNote({ ...created, simplify: true })}`;
    const ref = { id: created.id, prompt: created.prompt, simplify: true };

    const r = await w.answer(created.id, "rewrite", {
      text: "Answer this: why not today?",
    });
    expect(r.status).toBe(204);
    await waitUntil(() => w.sent().length === 1, "rewrite delivered");
    expect(w.sent()).toEqual([`${note}Answer this: why not today?`]);
    // The ref a queued message keeps is a simplify ref and nothing else: an
    // older server frames it as a rewrite request, not as a reply.
    expect(w.logged()).toEqual([
      { content: "Answer this: why not today?", ask: ref },
    ]);
    const open = await w.read(created.id);
    expect([
      open.closed === undefined,
      typeof open.simplifyRequestedAt,
    ]).toEqual([true, "number"]);

    // One request at a time, through either route.
    for (const [verb, json] of [
      ["rewrite", { text: "More context" }],
      ["rewrite", {}],
      ["simplify", {}],
    ] as const) {
      const again = await w.answer(created.id, verb, json);
      expect(`${verb} ${again.status} ${again.code}`).toBe(
        `${verb} 409 simplify_pending`,
      );
    }
    await sleep(50);
    expect(w.sent()).toHaveLength(1);

    // Undo withdraws a rewrite with words as it withdraws a simplify.
    expect((await w.answer(created.id, "simplify/undo")).status).toBe(204);
    await waitUntil(() => w.sent().length === 2, "withdrawal delivered");
    expect((await w.read(created.id)).simplifyRequestedAt).toBeUndefined();

    // No words, or only white space: the fixed simplify words.
    for (const [i, json] of [{}, { text: "  \n " }].entries()) {
      expect((await w.answer(created.id, "rewrite", json)).status).toBe(204);
      await waitUntil(() => w.sent().length === 3 + i * 2, "bare rewrite");
      expect(w.sent()[2 + i * 2]).toBe(`${note}${ASK_SIMPLIFY_TEXT}`);
      expect(w.logged()[2 + i * 2]).toEqual({
        content: ASK_SIMPLIFY_TEXT,
        ask: ref,
      });
      expect((await w.answer(created.id, "simplify/undo")).status).toBe(204);
      await waitUntil(() => w.sent().length === 4 + i * 2, "withdrawn");
    }

    // The alias takes no words, as before.
    const worded = await w.answer(created.id, "simplify", { text: "Shorter" });
    expect([worded.status, worded.code]).toEqual([400, "invalid_text"]);
    expect((await w.answer(created.id, "simplify")).status).toBe(204);
    await waitUntil(() => w.sent().length === 7, "alias delivered");
    expect(w.sent()[6]).toBe(`${note}${ASK_SIMPLIFY_TEXT}`);

    await w.close(created.id);
    const requests = (await w.read(created.id)).events.filter(
      (e) => e.kind === "simplify_requested",
    );
    // The words only where the member typed some.
    expect(requests.map((e) => ("text" in e ? e.text : null))).toEqual([
      "Answer this: why not today?",
      null,
      null,
      null,
    ]);
  });

  it(`takes words up to ASK_PROMPT_MAX and refuses longer ones or a non-string, sending and marking nothing`, async () => {
    const w = await world();
    const created = await w.open("Rotate the key?");
    for (const text of ["x".repeat(ASK_PROMPT_MAX + 1), 5, ["More"]]) {
      const r = await w.answer(created.id, "rewrite", { text });
      expect([r.status, r.code]).toEqual([400, "invalid_text"]);
    }
    await sleep(50);
    expect(w.sent()).toEqual([]);
    expect((await w.read(created.id)).simplifyRequestedAt).toBeUndefined();
    const longest = "x".repeat(ASK_PROMPT_MAX);
    expect(
      (await w.answer(created.id, "rewrite", { text: longest })).status,
    ).toBe(204);
    await waitUntil(() => w.sent().length === 1, "delivered");
    expect(w.sent()[0].endsWith(longest)).toBe(true);
  });

  it("is cleared by any agent edit that changes the ask, not only its prompt; an edit that changes nothing keeps it", async () => {
    const w = await world();
    const created = await w.open("Ship it?", {
      options: ["Yes", "No"],
      recommended: "Yes",
    });
    expect(
      (await w.answer(created.id, "rewrite", { text: "Use visuals" })).status,
    ).toBe(204);
    await waitUntil(() => w.sent().length === 1, "delivered");
    // Nothing changes: still waiting.
    expect((await w.patch(created.id, { recommended: "Yes" })).status).toBe(
      200,
    );
    expect(typeof (await w.read(created.id)).simplifyRequestedAt).toBe(
      "number",
    );
    // A new pick and no new prompt: the request is answered, and there is
    // no original to show.
    expect((await w.patch(created.id, { recommended: "No" })).status).toBe(200);
    const after = await w.read(created.id);
    expect([
      after.prompt,
      after.simplifyRequestedAt,
      after.originalPrompt,
    ]).toEqual(["Ship it?", undefined, undefined]);
  });
});

describe("a postpone (task 1466ea8b)", () => {
  it("closes the ask as postponed and tells the agent under its own note: the member's words, or the fixed words when there are none", async () => {
    const w = await world();
    const cases = [
      { json: {}, words: ASK_POSTPONED_TEXT, answer: undefined },
      { json: { text: "  " }, words: ASK_POSTPONED_TEXT, answer: undefined },
      {
        json: { text: "Circle back at: Monday 9am" },
        words: "Circle back at: Monday 9am",
        answer: "Circle back at: Monday 9am",
      },
    ];
    for (const [i, c] of cases.entries()) {
      const created = await w.open(`Rotate key ${i}?`);
      const postponedNote = askReplyNote({ ...created, postponed: true });
      // Its own note: not a reply's, a dismiss's, a filed task's or a
      // simplify request's.
      for (const other of [
        askReplyNote(created),
        askReplyNote({ ...created, dismissed: true }),
        askReplyNote({ ...created, taskId: "t1" }),
        askReplyNote({ ...created, simplify: true }),
      ])
        expect(postponedNote).not.toBe(other);

      const r = await w.answer(created.id, "postpone", c.json);
      expect(r.status).toBe(204);
      await waitUntil(() => w.sent().length === i + 1, "postpone delivered");
      expect(w.sent()[i]).toBe(
        `[${w.owner.username}] ${postponedNote}${c.words}`,
      );
      // postponed alone: no dismissed flag, so an older server that does not
      // know postponed frames it as a reply, not as a dismiss.
      // The session that opened it is on the ref once the agent has one.
      const got = w.logged()[i];
      const { sessionId: _session, ...ref } = got.ask as Record<
        string,
        unknown
      >;
      expect({ content: got.content, ask: ref }).toEqual({
        content: c.words,
        ask: { id: created.id, prompt: created.prompt, postponed: true },
      });
      const closed = (await w.read(created.id)).closed;
      expect([closed?.outcome, closed?.by, closed?.answer]).toEqual([
        "postponed",
        w.owner.username,
        c.answer,
      ]);
      // Closed: a second postpone sends nothing.
      expect((await w.answer(created.id, "postpone")).status).not.toBe(204);
    }
    await sleep(50);
    expect(w.sent()).toHaveLength(cases.length);
    // Nothing filed: a postpone is not a filed task.
    expect(w.srv.agentManager.getTasks()).toEqual([]);
  });

  it("refuses words that are not a string and leaves the ask open", async () => {
    const w = await world();
    const created = await w.open("Rotate the key?");
    const r = await w.answer(created.id, "postpone", { text: 5 });
    expect([r.status, r.code]).toEqual([400, "invalid_text"]);
    expect((await w.read(created.id)).closed).toBeUndefined();
    expect(w.sent()).toEqual([]);
  });
});

describe("a tag the agent recommends (task 1466ea8b)", () => {
  const pick = (e: AskEntry | AskMemberWire) => ({
    recommended: e.recommended ?? null,
    recommendedTag: e.recommendedTag ?? null,
    recommendedText: e.recommendedText ?? null,
  });

  it("is kept with its text on create, as JSON and as text/plain, for the agent, the member and the history", async () => {
    const w = await world();
    const json = await w.open("Drop the old rule?", {
      recommendedTag: "dismiss",
      recommendedText: "Not needed: the new rule covers it",
    });
    const text = await call(
      w.srv,
      "POST",
      `${w.base}?recommendedTag=postpone&recommendedText=${encodeURIComponent("Circle back at: Monday")}`,
      w.agent,
      { text: "Rotate the key?\n" },
    );
    expect(text.status).toBe(201);
    const bare = await w.open("Rewrite me?", { recommendedTag: "rewrite" });
    const want = [
      {
        recommended: null,
        recommendedTag: "dismiss",
        recommendedText: "Not needed: the new rule covers it",
      },
      {
        recommended: null,
        recommendedTag: "postpone",
        recommendedText: "Circle back at: Monday",
      },
      { recommended: null, recommendedTag: "rewrite", recommendedText: null },
    ];
    const ids = [json.id, (text.body as AskEntry).id, bare.id];
    expect([json, text.body as AskEntry, bare].map(pick)).toEqual(want);
    expect(
      await Promise.all(ids.map(async (id) => pick(await w.read(id)))),
    ).toEqual(want);
    const listed = (await call(w.srv, "GET", "/api/asks", w.member))
      .body as AskMemberWire[];
    expect(ids.map((id) => pick(listed.find((e) => e.id === id)!))).toEqual(
      want,
    );

    await w.close(json.id);
    const created = (await w.read(json.id)).events.find(
      (e) => e.kind === "created",
    ) as { ask: Partial<AskEntry> } | undefined;
    expect([created?.ask.recommendedTag, created?.ask.recommendedText]).toEqual(
      ["dismiss", "Not needed: the new rule covers it"],
    );
  });

  it("refuses a bad pick on create with 422 invalid_options and makes no ask", async () => {
    const w = await world();
    const bad: [string, Record<string, unknown>][] = [
      ["unknown tag", { recommendedTag: "automate" }],
      ["empty tag", { recommendedTag: "" }],
      ["tag that is not a string", { recommendedTag: 1 }],
      ["text without a tag", { recommendedText: "Not now" }],
      [
        "text that is not a string",
        { recommendedTag: "dismiss", recommendedText: 1 },
      ],
      [
        "text over the bound",
        {
          recommendedTag: "dismiss",
          recommendedText: "x".repeat(ASK_PROMPT_MAX + 1),
        },
      ],
      [
        "a tag and an option",
        {
          options: ["Yes", "No"],
          recommended: "Yes",
          recommendedTag: "dismiss",
        },
      ],
    ];
    for (const [label, fields] of bad) {
      const r = await call(w.srv, "POST", w.base, w.agent, {
        json: { text: "Ship it?", ...fields },
      });
      expect(`${label}: ${r.status} ${r.code}`).toBe(
        `${label}: 422 invalid_options`,
      );
    }
    const query = await call(
      w.srv,
      "POST",
      `${w.base}?recommendedTag=automate`,
      w.agent,
      { text: "Ship it?\n" },
    );
    expect([query.status, query.code]).toEqual([422, "invalid_options"]);
    const listed = (await call(w.srv, "GET", "/api/asks", w.member))
      .body as AskMemberWire[];
    expect(listed.length).toBe(0);
    // The bound itself is fine.
    await w.open("Ship it?", {
      recommendedTag: "dismiss",
      recommendedText: "x".repeat(ASK_PROMPT_MAX),
    });
  });

  it("on edit: an absent field keeps it, a new pick replaces the old one, '' removes the tag with its text, removing the options keeps the tag; a bad edit changes nothing", async () => {
    const w = await world();
    const { id } = await w.open("Ship it?", {
      options: ["Yes", "No"],
      recommended: "Yes",
    });
    const state = async () => pick(await w.read(id));
    const steps: [Record<string, unknown>, string | ReturnType<typeof pick>][] =
      [
        // A tag replaces the option pick.
        [
          {
            recommendedTag: "postpone",
            recommendedText: "Circle back at: 3pm",
          },
          {
            recommended: null,
            recommendedTag: "postpone",
            recommendedText: "Circle back at: 3pm",
          },
        ],
        // Absent: kept.
        [
          { priority: "P1" },
          {
            recommended: null,
            recommendedTag: "postpone",
            recommendedText: "Circle back at: 3pm",
          },
        ],
        // The text alone changes with the tag kept.
        [
          { recommendedText: "Circle back at: 5pm" },
          {
            recommended: null,
            recommendedTag: "postpone",
            recommendedText: "Circle back at: 5pm",
          },
        ],
        // An option pick replaces the tag and its text.
        [
          { recommended: "No" },
          { recommended: "No", recommendedTag: null, recommendedText: null },
        ],
        // A tag with no text replaces the option pick.
        [
          { recommendedTag: "rewrite" },
          {
            recommended: null,
            recommendedTag: "rewrite",
            recommendedText: null,
          },
        ],
        // Both at once: refused, nothing changes.
        [
          { recommended: "Yes", recommendedTag: "dismiss" },
          "422 invalid_options",
        ],
        [{ recommendedTag: "automate" }, "422 invalid_options"],
        [
          { recommendedText: "x".repeat(ASK_PROMPT_MAX + 1) },
          "422 invalid_options",
        ],
        // The options go; the tag is not an option pick and stays.
        [
          { options: [] },
          {
            recommended: null,
            recommendedTag: "rewrite",
            recommendedText: null,
          },
        ],
        [
          { recommendedTag: "dismiss", recommendedText: "Done already" },
          {
            recommended: null,
            recommendedTag: "dismiss",
            recommendedText: "Done already",
          },
        ],
        // "" removes the tag, and its text with it.
        [
          { recommendedTag: "" },
          { recommended: null, recommendedTag: null, recommendedText: null },
        ],
        // Text with no tag to go with: refused.
        [{ recommendedText: "Not now" }, "422 invalid_options"],
      ];
    let last = await state();
    for (const [body, want] of steps) {
      const r = await w.patch(id, body);
      const now = await state();
      if (typeof want === "string") {
        expect({ body, got: `${r.status} ${r.code}`, now }).toEqual({
          body,
          got: want,
          now: last,
        });
      } else {
        expect({ body, status: r.status, now }).toEqual({
          body,
          status: 200,
          now: want,
        });
      }
      last = now;
    }

    // The history records the tag fields an edit changed.
    await w.close(id);
    const edits = (await w.read(id)).events.filter((e) => e.kind === "edited");
    const first = edits[0] as { before: Record<string, unknown> };
    expect(first.before).toMatchObject({
      recommended: "Yes",
      recommendedTag: null,
      recommendedText: null,
    });
  });

  it("through /mcp: open_ask and edit_ask take the tag and its text", async () => {
    const w = await world();
    // /mcp is for an agent below Standard.
    const access = await call(
      w.srv,
      "PUT",
      `/api/agents/${w.asker.id}/access`,
      w.member,
      { json: { access: "office" } },
    );
    expect(access.status).toBe(200);
    const client = new Client({ name: "ask-tags-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${w.srv.baseUrl}/mcp`), {
        // A new access level mints a new token.
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
      prompt: "Drop the old rule?",
      recommendedTag: "dismiss",
      recommendedText: "Not needed",
    });
    expect(pick(await w.read(made.id))).toEqual({
      recommended: null,
      recommendedTag: "dismiss",
      recommendedText: "Not needed",
    });
    await tool<AskAgentWire>("edit_ask", {
      askId: made.id,
      recommendedTag: "postpone",
      recommendedText: "Circle back at: Friday",
    });
    expect(pick(await w.read(made.id))).toEqual({
      recommended: null,
      recommendedTag: "postpone",
      recommendedText: "Circle back at: Friday",
    });
    await tool<AskAgentWire>("edit_ask", {
      askId: made.id,
      recommendedTag: "",
    });
    expect(pick(await w.read(made.id))).toEqual({
      recommended: null,
      recommendedTag: null,
      recommendedText: null,
    });
  });
});
