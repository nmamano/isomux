// "... and automate" with the rule in the same ask (task 1b4dfa91). An answer
// with `automate` goes to the agent at once, and the ask stays open at its
// rule stage. The agent then adds the rule to that ask (PATCH with an
// instructions-line step, only after the answer). The member applies it,
// asks for a change (the rewrite route) or does not save it (dismiss). The
// ask closes with the member's answer as its closure, plus `rule` only when
// the line was saved. A "Rewrite and automate" keeps the words until the
// member answers the rewritten ask. Through the routes and /mcp, FakeBackend
// only. The store's closure mapping, the agent's removal and the load check
// are in server/asks.test.ts.
//
// The notes come from askReplyNote, so these tests pin which note a message
// gets (its AskRef), not its words: the words are read at review.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { askReplyNote } from "../asks.ts";
import type { AskEntry, AskRef } from "../../shared/types.ts";
import type {
  AskAgentWire,
  AskClosedWire,
} from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
const clients: Client[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

type Res = { status: number; code?: string; body: unknown };
type Auth = { bearer?: string; rawSessionId?: string };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: Auth,
  json?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
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

// The closure as the routes send it, with this task's `rule`.
type Closed = AskClosedWire["closed"] & { rule?: string };

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
  const cwd = mkdtempSync(join(tmpdir(), "ask-automate-rule-"));
  folders.push(cwd);
  const asker = await server.agentManager.spawn(
    "Asker",
    cwd,
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
    const r = await call(srv, "POST", base, agent, { text: prompt, ...json });
    expect(r.status).toBe(201);
    return r.body as AskEntry;
  };
  const answer = (id: string, verb: string, json: unknown = {}) =>
    call(srv, "POST", `/api/asks/${id}/${verb}`, member, json);
  // The token is read each time: an access change mints a new one.
  const read = async (id: string) =>
    (
      await call(srv, "GET", `${base}/${id}`, {
        bearer: getAgentTokenRaw(asker.id)!,
      })
    ).body as AskAgentWire &
      Partial<Pick<AskClosedWire, "events">> & { closed?: Closed };
  const patch = (id: string, json: unknown) =>
    call(srv, "PATCH", `${base}/${id}`, agent, json);
  const apply = (id: string, json: unknown) =>
    call(srv, "POST", `/api/asks/${id}/action`, member, json);
  const instructions = async () => {
    const r = await call(
      srv,
      "GET",
      `/api/agents/${asker.id}/instructions`,
      member,
    );
    expect(r.status).toBe(200);
    return (r.body as { instructions: string | null }).instructions ?? "";
  };
  const writeByHand = async (text: string) => {
    const { version } = (
      await call(srv, "GET", `/api/agents/${asker.id}/instructions`, member)
    ).body as { version: string };
    const r = await call(
      srv,
      "PUT",
      `/api/agents/${asker.id}/instructions`,
      member,
      { instructions: text, version },
    );
    expect(r.status).toBe(200);
  };
  // The ref each logged member message carries, without the session.
  const loggedRefs = () =>
    srv.agentManager
      .getAgentLogs(asker.id)
      .filter((e) => e.kind === "user_message")
      .map((e) => {
        const { sessionId: _s, ...ref } = (e.metadata?.ask ?? {}) as Record<
          string,
          unknown
        >;
        return ref as unknown as AskRef;
      });
  const sent = () =>
    srv.fakeBackend.sessions
      .filter((s) => s.opts.agentId === asker.id)
      .flatMap((s) => s.sent.map((m) => m.text));
  // The done notices of step asks in the agent's chat.
  const doneLines = () =>
    srv.agentManager
      .getAgentLogs(asker.id)
      .filter((e) => e.kind === "system")
      .map((e) => JSON.stringify(e).match(/systemEntries\.stepAsk\.\w+/)?.[0])
      .filter((key): key is string => key !== undefined);
  // An open ask at its rule stage: answered with automate, delivered.
  const atRuleStage = async (
    prompt: string,
    verb = "reply",
    json: Record<string, unknown> = { text: "Ship now" },
    words = RULE_WORDS,
  ) => {
    const made = await open(prompt);
    const before = sent().length;
    const r = await answer(made.id, verb, { ...json, automate: words });
    expect(r.status).toBe(204);
    await waitUntil(() => sent().length === before + 1, "answer delivered");
    return made;
  };
  return {
    srv,
    owner,
    ownerId,
    asker,
    agent,
    member,
    base,
    open,
    answer,
    read,
    patch,
    apply,
    instructions,
    writeByHand,
    loggedRefs,
    sent,
    doneLines,
    atRuleStage,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const RULE_WORDS = "Pick the copy yourself next time.";
const LINE = "Tab order and copy changes: go with your pick, tell me after.";
const lineStep = (line = LINE) => ({
  kind: "instructions-line" as const,
  scope: "agent" as const,
  line,
});

// The agent adds its rule to the ask at the rule stage.
async function addRule(w: World, id: string, line = LINE) {
  const r = await w.patch(id, { step: lineStep(line) });
  expect([r.status, r.code]).toEqual([200, undefined]);
  return r.body as AskEntry;
}

const isOpen = async (w: World, id: string) =>
  (await w.read(id)).closed === undefined;

describe("an answer with automate keeps the ask open (task 1b4dfa91)", () => {
  it("reply, dismiss and postpone: the agent gets the answer at once, once; the ask stays open with the answer and the words; an answered event", async () => {
    const w = await world();
    const cases = [
      {
        verb: "reply",
        json: { text: "Ship now" },
        outcome: "replied",
        text: "Ship now",
      },
      { verb: "dismiss", json: {}, outcome: "dismissed", text: undefined },
      {
        verb: "postpone",
        json: { text: "Monday" },
        outcome: "postponed",
        text: "Monday",
      },
    ];
    let n = 0;
    for (const c of cases)
      for (const words of [RULE_WORDS, ""]) {
        const made = await w.atRuleStage(`Ship ${n}?`, c.verb, c.json, words);
        n++;
        const ref = w.loggedRefs()[n - 1];
        expect({ verb: c.verb, automate: ref.automate }).toEqual({
          verb: c.verb,
          automate: words,
        });
        expect(w.sent()[n - 1]).toContain(askReplyNote(ref));
        const now = await w.read(made.id);
        expect({
          verb: c.verb,
          open: now.closed === undefined,
          words: now.automateRequest?.words,
          outcome: now.automateRequest?.answer?.outcome,
          text: now.automateRequest?.answer?.text,
        }).toEqual({
          verb: c.verb,
          open: true,
          words,
          outcome: c.outcome as "replied",
          text: c.text,
        });
      }
    // Nothing is sent twice.
    await sleep(100);
    expect(w.sent()).toHaveLength(n);
    // The member's list shows the rule stage too.
    const listed = (await call(w.srv, "GET", "/api/asks", w.member))
      .body as AskEntry[];
    expect(
      listed.filter((e) => e.automateRequest?.answer !== undefined).length,
    ).toBe(n);
  });

  it("at the rule stage, reply, postpone, a bare simplify and a rewrite before the rule are 409 answered, with nothing sent or changed", async () => {
    const w = await world();
    const made = await w.atRuleStage("Ship it?");
    const before = await w.read(made.id);
    for (const [verb, json] of [
      ["reply", { text: "No, wait" }],
      ["postpone", { text: "Friday" }],
      ["postpone", {}],
      ["simplify", {}],
      ["rewrite", { text: "Shorter" }],
    ] as const) {
      const r = await w.answer(made.id, verb, json);
      expect({ verb, status: r.status, code: r.code }).toEqual({
        verb,
        status: 409,
        code: "answered",
      });
    }
    await sleep(100);
    expect(w.sent()).toHaveLength(1);
    const after = await w.read(made.id);
    expect([
      after.closed === undefined,
      after.automateRequest,
      after.simplifyRequestedAt,
    ]).toEqual([true, before.automateRequest, undefined]);
  });

  it("an answered paged ask stops ringing: the answer acks it as the member who answered", async () => {
    const w = await world();
    const made = await w.open("Restart the box?", { page: true });
    expect((await w.read(made.id)).page?.state).toBe("ringing");
    const r = await w.answer(made.id, "reply", {
      text: "Yes",
      automate: RULE_WORDS,
    });
    expect(r.status).toBe(204);
    await waitUntil(() => w.sent().length === 1, "delivered");
    const now = await w.read(made.id);
    expect([now.closed === undefined, now.page?.state]).toEqual([
      true,
      "acked",
    ]);
  });

  it("the rule stage survives a restart: the ask comes back open with its automate request, and a reply is still refused", async () => {
    const w = await world();
    const made = await w.atRuleStage("Ship it?");
    const before = await w.read(made.id);
    expect(before.automateRequest?.answer?.outcome).toBe("replied");
    server = await w.srv.restart();
    const srv = server;
    const agent = { bearer: getAgentTokenRaw(w.asker.id)! };
    const after = (await call(srv, "GET", `${w.base}/${made.id}`, agent))
      .body as AskAgentWire;
    expect(after.automateRequest).toEqual(before.automateRequest);
    const r = await call(srv, "POST", `/api/asks/${made.id}/reply`, w.member, {
      text: "Again",
    });
    expect([r.status, r.code]).toEqual([409, "answered"]);
  });
});

describe("the agent adds the rule to the same ask (task 1b4dfa91)", () => {
  it("PATCH with an instructions-line step: refused before the answer (409 not_answered) and on a plain ask (400), taken at the rule stage with the target filled", async () => {
    const w = await world();
    const plain = await w.open("Ship it?");
    const r1 = await w.patch(plain.id, { step: lineStep() });
    expect([r1.status, r1.code]).toEqual([400, "invalid_request"]);
    // A "Rewrite and automate": the words wait for the answer.
    const rewritten = await w.open("Ship the tab order?");
    expect(
      (
        await w.answer(rewritten.id, "rewrite", {
          text: "Use a picture",
          automate: RULE_WORDS,
        })
      ).status,
    ).toBe(204);
    await waitUntil(() => w.sent().length === 1, "rewrite delivered");
    const r2 = await w.patch(rewritten.id, { step: lineStep() });
    expect([r2.status, r2.code]).toEqual([409, "not_answered"]);
    expect([
      (await w.read(plain.id)).step,
      (await w.read(rewritten.id)).step,
    ]).toEqual([undefined, undefined]);
    const made = await w.atRuleStage("Ship now?");
    const entry = await addRule(w, made.id);
    expect(entry.step).toEqual({ ...lineStep(), targetId: w.asker.id });
    expect((await w.read(made.id)).step).toEqual(entry.step);
  });

  it("at the rule stage PATCH takes only the step: any other field is 409 answered and changes nothing", async () => {
    const w = await world();
    const made = await w.atRuleStage("Ship it?", "reply", {
      text: "Ship now",
    });
    for (const json of [
      { text: "Ship it today?" },
      { options: ["Yes", "No"] },
      { link: "https://example.com/doc" },
      { priority: "P1" },
      { automateText: "Always ship" },
      { recommendedTag: "dismiss" },
      { text: "Ship it today?", step: lineStep() },
    ]) {
      const r = await w.patch(made.id, json);
      expect({ json, status: r.status, code: r.code }).toEqual({
        json,
        status: 409,
        code: "answered",
      });
    }
    const now = await w.read(made.id);
    expect([now.prompt, now.options, now.priority, now.step]).toEqual([
      "Ship it?",
      undefined,
      made.priority,
      undefined,
    ]);
  });

  it("a bad rule or a line already there is refused as for a rule ask, and the rule stage stays", async () => {
    const w = await world();
    await w.writeByHand("Keep it short.");
    const made = await w.atRuleStage("Ship it?");
    for (const [step, status, code] of [
      [lineStep("a\nb"), 400, "invalid_request"],
      [{ kind: "browser-pairing" }, 400, "invalid_request"],
      [lineStep("Keep it short."), 409, "step_done"],
    ] as const) {
      const r = await w.patch(made.id, { step });
      expect({ step, status: r.status, code: r.code }).toEqual({
        step,
        status,
        code,
      });
    }
    const now = await w.read(made.id);
    expect([now.step, now.automateRequest?.answer?.outcome]).toEqual([
      undefined,
      "replied",
    ]);
  });

  it("through /mcp: edit_ask adds the rule at the rule stage", async () => {
    const w = await world();
    const made = await w.atRuleStage("Ship it?");
    const access = await call(
      w.srv,
      "PUT",
      `/api/agents/${w.asker.id}/access`,
      w.member,
      { access: "office" },
    );
    expect(access.status).toBe(200);
    const client = new Client({ name: "ask-rule-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${w.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(w.asker.id)}` },
        },
      }),
    );
    clients.push(client);
    const r = (await client.callTool({
      name: "edit_ask",
      arguments: { askId: made.id, step: lineStep() },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect({
      isError: !!r.isError,
      text: (r.content ?? []).map((p) => p.text ?? "").join("\n"),
    }).toMatchObject({ isError: false });
    expect((await w.read(made.id)).step).toEqual({
      ...lineStep(),
      targetId: w.asker.id,
    });
  });
});

describe("the rule is settled in the same ask (task 1b4dfa91)", () => {
  it("Apply writes the line and closes the ask with the answer as its closure plus the rule; one done notice; the answered event is in the history", async () => {
    const w = await world();
    for (const [verb, json, outcome, answerText, words] of [
      ["reply", { text: "Ship now" }, "replied", "Ship now", RULE_WORDS],
      ["dismiss", {}, "dismissed", undefined, ""],
      ["postpone", { text: "Monday" }, "postponed", "Monday", RULE_WORDS],
    ] as const) {
      const line = `${LINE} (${verb})`;
      const made = await w.atRuleStage(`Ship ${verb}?`, verb, json, words);
      await addRule(w, made.id, line);
      const r = await w.apply(made.id, { scope: "agent", line });
      expect({ verb, ok: r.status < 300 }).toEqual({ verb, ok: true });
      await waitUntil(async () => !(await isOpen(w, made.id)), "closed");
      const closed = await w.read(made.id);
      expect({
        verb,
        outcome: closed.closed?.outcome,
        answer: closed.closed?.answer,
        automate: closed.closed?.automate,
        rule: closed.closed?.rule,
      }).toEqual({
        verb,
        outcome,
        answer: answerText,
        automate: words,
        rule: line,
      });
      const answered = (closed.events ?? []).filter(
        (e) => e.kind === ("answered" as string),
      );
      expect({ verb, answered: answered.length }).toEqual({
        verb,
        answered: 1,
      });
    }
    expect(await w.instructions()).toBe(
      ["reply", "dismiss", "postpone"].map((v) => `${LINE} (${v})`).join("\n"),
    );
    expect(w.doneLines()).toEqual([
      "systemEntries.stepAsk.instructionsLineAdded",
      "systemEntries.stepAsk.instructionsLineAdded",
      "systemEntries.stepAsk.instructionsLineAdded",
    ]);
  });

  it("a line written by hand closes it the same way: the answer plus the rule", async () => {
    const w = await world();
    const made = await w.atRuleStage("Ship it?");
    await addRule(w, made.id);
    await w.writeByHand(`Keep it short.\n${LINE}`);
    await waitUntil(async () => !(await isOpen(w, made.id)), "closed");
    const closed = (await w.read(made.id)).closed;
    expect([closed?.outcome, closed?.answer, closed?.rule]).toEqual([
      "replied",
      "Ship now",
      LINE,
    ]);
  });

  it("Change (the rewrite route with words) asks for a new rule under a rule-change note naming the line; the agent's new step clears the mark and Apply takes it", async () => {
    const w = await world();
    const made = await w.atRuleStage("Ship it?");
    await addRule(w, made.id);
    const r = await w.answer(made.id, "rewrite", { text: "Only copy changes" });
    expect(r.status).toBe(204);
    await waitUntil(() => w.sent().length === 2, "change delivered");
    const ref = w.loggedRefs()[1];
    expect(ref.ruleChange).toBe(LINE);
    expect(w.sent()[1]).toContain(askReplyNote(ref));
    expect(w.sent()[1]).toContain("Only copy changes");
    const marked = await w.read(made.id);
    expect([
      marked.closed === undefined,
      typeof marked.simplifyRequestedAt,
    ]).toEqual([true, "number"]);
    const tuned = "Copy changes only: go with your pick.";
    await addRule(w, made.id, tuned);
    expect((await w.read(made.id)).simplifyRequestedAt).toBe(undefined);
    expect((await w.apply(made.id, { scope: "agent", line: LINE })).code).toBe(
      "step_changed",
    );
    expect(
      (await w.apply(made.id, { scope: "agent", line: tuned })).status,
    ).toBeLessThan(300);
    await waitUntil(async () => !(await isOpen(w, made.id)), "closed");
    expect((await w.read(made.id)).closed?.rule).toBe(tuned);
  });

  it("an Undo of a Change keeps the rule stage: the answer stays, and a second answer is still refused", async () => {
    const w = await world();
    const made = await w.atRuleStage("Ship it?");
    await addRule(w, made.id);
    expect(
      (await w.answer(made.id, "rewrite", { text: "Only copy changes" }))
        .status,
    ).toBe(204);
    await waitUntil(() => w.sent().length === 2, "change delivered");
    expect((await w.answer(made.id, "simplify/undo", {})).status).toBe(204);
    await waitUntil(
      async () => (await w.read(made.id)).simplifyRequestedAt === undefined,
      "mark cleared",
    );
    const now = await w.read(made.id);
    expect([
      now.closed === undefined,
      now.automateRequest?.answer?.outcome,
      now.step?.kind,
    ]).toEqual([true, "replied", "instructions-line"]);
    const again = await w.answer(made.id, "reply", { text: "Again" });
    expect([again.status, again.code]).toEqual([409, "answered"]);
  });

  it("Don't save (dismiss at the rule stage), before and after the rule: closes with the answer and no rule, the agent reads the rule-declined note, nothing is written", async () => {
    const w = await world();
    let n = 0;
    for (const withRule of [false, true])
      for (const text of [undefined, "Not worth a rule"]) {
        const made = await w.atRuleStage(`Ship ${n}?`);
        if (withRule) await addRule(w, made.id);
        const before = w.sent().length;
        const r = await w.answer(made.id, "dismiss", text ? { text } : {});
        expect(r.status).toBe(204);
        await waitUntil(() => w.sent().length === before + 1, "declined");
        const ref = w.loggedRefs()[before];
        expect({ withRule, text, declined: ref.ruleDeclined }).toEqual({
          withRule,
          text,
          declined: true,
        });
        expect(w.sent()[before]).toContain(askReplyNote(ref));
        if (text) expect(w.sent()[before]).toContain(text);
        const closed = (await w.read(made.id)).closed;
        expect({
          withRule,
          text,
          outcome: closed?.outcome,
          answer: closed?.answer,
          automate: closed?.automate,
          rule: closed && "rule" in closed,
        }).toEqual({
          withRule,
          text,
          outcome: "replied",
          answer: "Ship now",
          automate: RULE_WORDS,
          rule: false,
        });
        n++;
      }
    expect(await w.instructions()).toBe("");
    expect(w.doneLines()).toEqual([]);
  });

  it("the agent's delete at the rule stage closes with the member's answer and no rule", async () => {
    const w = await world();
    const made = await w.atRuleStage("Ship it?");
    await addRule(w, made.id);
    const r = await call(w.srv, "DELETE", `${w.base}/${made.id}`, w.agent);
    expect(r.status).toBe(204);
    const closed = (await w.read(made.id)).closed;
    expect([
      closed?.outcome,
      closed?.answer,
      closed?.automate,
      closed && "rule" in closed,
    ]).toEqual(["replied", "Ship now", RULE_WORDS, false]);
  });
});

describe("Rewrite and automate (task 1b4dfa91)", () => {
  it("keeps the words until the member answers the rewritten ask: that answer carries them without automate in the body, and the ask goes to its rule stage", async () => {
    const w = await world();
    const made = await w.open("Ship the tab order?");
    expect(
      (
        await w.answer(made.id, "rewrite", {
          text: "Use a picture",
          automate: RULE_WORDS,
        })
      ).status,
    ).toBe(204);
    await waitUntil(() => w.sent().length === 1, "rewrite delivered");
    const waiting = await w.read(made.id);
    expect([
      waiting.automateRequest?.words,
      waiting.automateRequest?.answer,
      typeof waiting.simplifyRequestedAt,
    ]).toEqual([RULE_WORDS, undefined, "number"]);
    // The agent rewrites the ask.
    const rw = await w.patch(made.id, { text: "Ship the new tab order?" });
    expect(rw.status).toBe(200);
    // The member answers it, without automate.
    expect((await w.answer(made.id, "reply", { text: "Yes" })).status).toBe(
      204,
    );
    await waitUntil(() => w.sent().length === 2, "answer delivered");
    const ref = w.loggedRefs()[1];
    expect([ref.automate, ref.simplify]).toEqual([RULE_WORDS, undefined]);
    expect(w.sent()[1]).toContain(askReplyNote(ref));
    const now = await w.read(made.id);
    expect([
      now.closed === undefined,
      now.automateRequest?.words,
      now.automateRequest?.answer?.outcome,
      now.automateRequest?.answer?.text,
    ]).toEqual([true, RULE_WORDS, "replied", "Yes"]);
    await addRule(w, made.id);
  });

  it("its Undo before the rewrite takes back the automate request too: the next answer goes without the words and closes the ask", async () => {
    const w = await world();
    const made = await w.open("Ship the tab order?");
    expect(
      (
        await w.answer(made.id, "rewrite", {
          text: "Use a picture",
          automate: RULE_WORDS,
        })
      ).status,
    ).toBe(204);
    await waitUntil(() => w.sent().length === 1, "rewrite delivered");
    expect((await w.read(made.id)).automateRequest?.words).toBe(RULE_WORDS);
    expect((await w.answer(made.id, "simplify/undo", {})).status).toBe(204);
    await waitUntil(() => w.sent().length === 2, "undo delivered");
    await waitUntil(
      async () => (await w.read(made.id)).simplifyRequestedAt === undefined,
      "mark cleared",
    );
    expect((await w.read(made.id)).automateRequest).toBe(undefined);
    expect((await w.answer(made.id, "reply", { text: "Yes" })).status).toBe(
      204,
    );
    await waitUntil(() => w.sent().length === 3, "answer delivered");
    expect("automate" in w.loggedRefs()[2]).toBe(false);
    expect((await w.read(made.id)).closed?.outcome).toBe("replied");
  });
});

describe("the notes of the rule stage (task 1b4dfa91)", () => {
  it("a rule change and a declined rule each get their own note; the change's names the line", () => {
    const ref: AskRef = { id: "a1b2c3d4", prompt: "Ship the tab order?" };
    const rewrite = askReplyNote({ ...ref, simplify: true });
    const change = askReplyNote({ ...ref, simplify: true, ruleChange: LINE });
    const dismissed = askReplyNote({ ...ref, dismissed: true });
    const declined = askReplyNote({
      ...ref,
      dismissed: true,
      ruleDeclined: true,
    });
    expect(new Set([rewrite, change, dismissed, declined]).size).toBe(4);
    expect(change).toContain(LINE);
    expect(rewrite).not.toContain(LINE);
  });
});
