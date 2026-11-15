// A setting change that starts a new conversation hands off (task 1fdda17f):
// the engine, the manager, and the folder of an engine whose session keeps
// its birth folder (Codex). The new conversation, on the NEW settings, runs
// one brief turn that reads the previous conversation from the agent's logs;
// then a fresh session opens on that brief. When the brief turn fails, the
// conversation the change opened stays, and the agent's next prompt names
// the previous conversation instead.
//
// Seam: the DI manager (createAgentManager) with one FakeBackend per engine,
// as in manual-handoff.test.ts. Copy is never matched. A brief prompt is
// found by the route it must name, `/api/agents/<id>/logs?...session=<id>`,
// a protocol value; the conversation it names is read from that URL.
// Every agent here has its automatic-handoff switch OFF: a settings handoff
// does not depend on it.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { translatorForLanguage } from "../i18n.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { createMember, getUserByName } from "../users.ts";
import { AUTO_HANDOFF_FRESH_NOTICE } from "../auto-handoff.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";
import type { EventHandler } from "../internal-types.ts";
import type { AgentInfo, LogEntry, RoomWire } from "../../shared/types.ts";

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

const activeFakes: FakeBackend[] = [];
afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}
// Long enough for a brief turn and a reset that are NOT supposed to happen.
const settle = () => sleep(150);

const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];
const en = translatorForLanguage("en");
const BRIEF = "BRIEF-TEXT: rule R1 stands, finish step 4.";
// Every member message in this file ends in -MSG, so a prompt that carries
// one is never taken for a brief prompt.
const MSG = "-MSG";
// What the signed-out Codex fake tells the member: the sign-in entry.
const SIGN_IN = "SIGN-IN-HOW-TO-CODEX";

// The brief prompt names the route to the previous conversation. Returns
// the session ids it names, or null when `text` is not a brief prompt.
function briefSessionIds(agentId: string, text: string): string[] | null {
  if (text.includes(BRIEF) || text.includes(MSG)) return null;
  const route = new RegExp(
    `/api/agents/${agentId}/logs\\?[^\\s\`'"]*?\\bsession=([A-Za-z0-9_-]+)`,
    "g",
  );
  const ids = [...text.matchAll(route)].map((m) => m[1]);
  return ids.length > 0 ? ids : null;
}

interface BriefTurn {
  session: FakeSession;
  engine: "claude" | "codex";
  // The agent as it stood when the brief prompt was sent.
  agentType: AgentInfo["agentType"];
  userId: string | null | undefined;
  // The conversation(s) the prompt points at.
  names: string[];
}

interface Harness {
  mgr: ReturnType<typeof createAgentManager>;
  claude: FakeBackend;
  codex: FakeBackend;
  logs: LogEntry[];
  briefs: BriefTurn[];
  // How a session answers a brief prompt. Default: completes with BRIEF.
  brief: { answer: (s: FakeSession) => void };
  codexSignedOut: { on: boolean };
  agentId: { id: string | null };
}

function makeHarness(
  opts: { codexAutoHandoff?: boolean; abortInPlace?: boolean } = {},
): Harness {
  const logs: LogEntry[] = [];
  const briefs: BriefTurn[] = [];
  const brief: Harness["brief"] = {
    answer: (s) => s.completeTurn({ text: BRIEF }),
  };
  const codexSignedOut = { on: false };
  const agentId: Harness["agentId"] = { id: null };
  let mgr: ReturnType<typeof createAgentManager> | null = null;
  const onSend =
    (engine: BriefTurn["engine"]) =>
    (text: string, _a: unknown, s: FakeSession) => {
      const id = agentId.id;
      if (!id) return;
      const names = briefSessionIds(id, text);
      if (!names) return;
      const info = mgr?.getAgent(id);
      briefs.push({
        session: s,
        engine,
        agentType: info?.agentType,
        userId: info?.userId,
        names,
      } as BriefTurn);
      setTimeout(() => brief.answer(s), 0);
    };
  const session = (engine: BriefTurn["engine"]) => ({
    abortInPlace: opts.abortInPlace ?? false,
    onSend: onSend(engine),
  });
  const claude = new FakeBackend({
    session: session("claude"),
    newSessionId: () => randomUUID(),
  });
  const codex = new FakeBackend({
    session: session("codex"),
    newSessionId: () => randomUUID(),
    signedOut: () => codexSignedOut.on,
    loginInstructions: { kind: "login", text: SIGN_IN },
    capabilities: {
      ...DEFAULT_AGENT_CAPABILITIES,
      autoHandoff: opts.codexAutoHandoff ?? true,
    },
  });
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type === "log_entry" && ev.entry) logs.push(ev.entry);
  };
  mgr = createAgentManager({
    resolveBackend: (t) => (t === "codex" ? codex : claude),
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    eventSink: sink,
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(claude, codex);
  return {
    mgr,
    claude,
    codex,
    logs,
    briefs,
    brief,
    codexSignedOut,
    agentId,
  };
}

async function spawn(
  h: Harness,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  const info = await h.mgr.spawn(
    "Receiver",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
    undefined,
    undefined,
    undefined,
    undefined,
    agentType,
  );
  if (!info) throw new Error("spawn returned null");
  h.agentId.id = info.id;
  await h.mgr.editAgent(info.id, { autoHandoff: false });
  expect(h.mgr.getAgent(info.id)?.autoHandoff).toBe(false);
  return info;
}

const stateOf = (h: Harness, id: string) => h.mgr.getAgent(id)?.state;
const texts = (s: FakeSession | undefined) =>
  (s?.sent ?? []).map((m) => m.text);
const sent = (s: FakeSession | undefined, needle: string) =>
  texts(s).some((t) => t.includes(needle));
const allSessions = (h: Harness) => [...h.claude.sessions, ...h.codex.sessions];
const sessionFor = (h: Harness, id: string) => {
  const own = allSessions(h).filter((s) => s.opts.agentId === id);
  return own[own.length - 1];
};
const queueOf = (h: Harness, id: string) =>
  h.mgr
    .getAllAgents()
    .find((a) => a.id === id)
    ?.queue?.map((m) => m.text);
// The member's line when a setting handoff wrote no brief. The cast lets
// this file type-check before the key exists in the catalog.
const settingFailedLine = () =>
  (en.t as (key: string) => string)("systemEntries.settingHandoff.failed");
const systemLines = (h: Harness) =>
  h.logs.filter((e) => e.kind === "system").map((e) => e.content);

// One finished member turn on the agent's current engine. Returns the
// session that ran it (its id is the conversation a change hands off).
async function finishedTurn(
  h: Harness,
  id: string,
  text = `work${MSG}`,
): Promise<FakeSession> {
  void h.mgr.sendMessage(id, text);
  await waitUntil(
    () => stateOf(h, id) === "thinking" && sent(sessionFor(h, id), text),
    `turn "${text}" running`,
  );
  const s = sessionFor(h, id);
  s.completeTurn({ text: "done" });
  await waitUntil(
    () => stateOf(h, id) === "waiting_for_response",
    "at rest after the turn",
  );
  return s;
}

// The session that got the brief as its first prompt: the conversation the
// handoff opened.
async function handedOffTo(h: Harness, id: string): Promise<FakeSession> {
  await waitUntil(
    () =>
      allSessions(h).some(
        (s) => s.opts.agentId === id && s.sent.length > 0 && sent(s, BRIEF),
      ),
    "a session opened on the brief",
  );
  return allSessions(h).find(
    (s) => s.opts.agentId === id && s.sent.length > 0 && sent(s, BRIEF),
  )!;
}

function expectInOrder(text: string, needles: string[]) {
  const at = needles.map((n) => text.indexOf(n));
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
}

// The user store outlives the state dir reset in a multi-file run.
function memberId(name: string): string {
  const known = getUserByName(name);
  if (known) return known.id;
  const created = createMember(name, { role: "member" });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}

// The shared success checks: one brief turn, in a fresh session of the
// new settings, that names the previous conversation; then a fresh session
// whose first prompt holds the brief and names the previous conversation
// for its notice.
async function expectHandedOff(
  h: Harness,
  id: string,
  previous: FakeSession,
  newEngine: BriefTurn["engine"],
): Promise<{ brief: BriefTurn; fresh: FakeSession }> {
  const fresh = await handedOffTo(h, id);
  expect(h.briefs).toHaveLength(1);
  const [brief] = h.briefs;
  expect(brief.engine).toBe(newEngine);
  expect(brief.session).not.toBe(previous);
  expect(brief.session.isResume).toBe(false);
  expect(brief.names.every((n) => n === previous.sessionId)).toBe(true);
  // The brief went to a fresh session, not into the brief turn's own.
  expect(fresh).not.toBe(brief.session);
  expect(fresh.isResume).toBe(false);
  const first = fresh.sent[0].text;
  expect(first).toContain(BRIEF);
  expect(first).toContain(previous.sessionId);
  expect(first).not.toContain(AUTO_HANDOFF_FRESH_NOTICE);
  // The previous conversation never got a brief prompt.
  expect(h.briefs.some((b) => b.session === previous)).toBe(false);
  // Nothing more: no second brief turn.
  await settle();
  expect(h.briefs).toHaveLength(1);
  return { brief, fresh };
}

describe("a setting change hands off, on the new settings", () => {
  it("engine: the brief turn runs on the new engine", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const c0 = await finishedTurn(h, info.id);
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    const { brief, fresh } = await expectHandedOff(h, info.id, c0, "codex");
    expect(brief.agentType).toBe("codex");
    expect(h.codex.sessions).toContain(fresh);
  });

  it("manager: the brief turn runs under the new manager", async () => {
    const blake = memberId("Blake");
    const h = makeHarness();
    const info = await spawn(h);
    const c0 = await finishedTurn(h, info.id);
    await h.mgr.setManager(info.id, blake, "Blake", "Owner");
    const { brief } = await expectHandedOff(h, info.id, c0, "claude");
    expect(brief.userId).toBe(blake);
  });

  it("folder, Codex with a live session: the brief turn runs in the new folder", async () => {
    const h = makeHarness();
    const info = await spawn(h, "codex");
    const c0 = await finishedTurn(h, info.id);
    expect(c0.closed).toBe(false);
    const cwd = join(STATE_ROOT, "tools");
    mkdirSync(cwd, { recursive: true });
    await h.mgr.editAgent(info.id, { cwd });
    const { brief, fresh } = await expectHandedOff(h, info.id, c0, "codex");
    expect(brief.session.opts.cwd).toBe(cwd);
    expect(fresh.opts.cwd).toBe(cwd);
  });

  it("folder, Codex released: the brief turn runs in the new folder", async () => {
    const h = makeHarness();
    const info = await spawn(h, "codex");
    const c0 = await finishedTurn(h, info.id);
    expect(await h.mgr.sweepIdleAgents(0)).toBe(1);
    expect(h.mgr.getAgent(info.id)?.dormant).toBe(true);
    const cwd = join(STATE_ROOT, "tools");
    mkdirSync(cwd, { recursive: true });
    await h.mgr.editAgent(info.id, { cwd });
    const { brief } = await expectHandedOff(h, info.id, c0, "codex");
    expect(brief.session.opts.cwd).toBe(cwd);
  });
});

describe("what waits goes to the handed-off conversation, after the brief", () => {
  it("a message queued before the change and one sent during the brief turn", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    // A running turn with a message queued behind it.
    void h.mgr.sendMessage(info.id, `busy${MSG}`);
    await waitUntil(
      () =>
        stateOf(h, info.id) === "thinking" &&
        sent(sessionFor(h, info.id), `busy${MSG}`),
      "busy turn running",
    );
    void h.mgr.sendMessage(info.id, `BEFORE${MSG}`);
    await waitUntil(
      () => queueOf(h, info.id)?.includes(`BEFORE${MSG}`) === true,
      "BEFORE queued",
    );
    // Park the brief turn, to send a message while it runs.
    let parked: FakeSession | null = null;
    h.brief.answer = (s) => {
      parked = s;
    };
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(() => parked !== null, "brief turn running");
    void h.mgr.sendMessage(info.id, `DURING${MSG}`);
    await waitUntil(
      () => queueOf(h, info.id)?.includes(`DURING${MSG}`) === true,
      "DURING queued",
    );
    parked!.completeTurn({ text: BRIEF });
    const fresh = await handedOffTo(h, info.id);
    expectInOrder(fresh.sent[0].text, [BRIEF, `BEFORE${MSG}`, `DURING${MSG}`]);
    // Neither went to the brief turn's session.
    expect(sent(parked!, `BEFORE${MSG}`)).toBe(false);
    expect(sent(parked!, `DURING${MSG}`)).toBe(false);
  });
});

describe("no handoff", () => {
  it("when the previous conversation is empty", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await settle();
    expect(h.briefs).toHaveLength(0);
    void h.mgr.sendMessage(info.id, `HELLO${MSG}`);
    await waitUntil(
      () => sent(h.codex.lastSession, `HELLO${MSG}`),
      "message delivered",
    );
    expect(h.codex.sessions).toHaveLength(1);
    expect(h.briefs).toHaveLength(0);
  });

  it("when the new engine cannot hand off", async () => {
    const h = makeHarness({ codexAutoHandoff: false });
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await settle();
    expect(h.briefs).toHaveLength(0);
    void h.mgr.sendMessage(info.id, `HELLO${MSG}`);
    await waitUntil(
      () => sent(h.codex.lastSession, `HELLO${MSG}`),
      "message delivered",
    );
    expect(h.codex.sessions).toHaveLength(1);
    expect(h.briefs).toHaveLength(0);
  });

  it("a member's new conversation on another engine is not a setting change", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    await h.mgr.newConversation(info.id, "codex");
    expect(h.mgr.getAgent(info.id)?.agentType).toBe("codex");
    await settle();
    expect(h.briefs).toHaveLength(0);
    void h.mgr.sendMessage(info.id, `HELLO${MSG}`);
    await waitUntil(
      () => sent(h.codex.lastSession, `HELLO${MSG}`),
      "message delivered",
    );
    expect(h.briefs).toHaveLength(0);
  });
});

describe("a brief turn that fails", () => {
  it("the new engine is signed out: no handoff, the member is told, and the next prompt names the previous conversation", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    // A message waits behind a running turn when the switch comes.
    void h.mgr.sendMessage(info.id, `busy${MSG}`);
    await waitUntil(
      () =>
        stateOf(h, info.id) === "thinking" &&
        sent(sessionFor(h, info.id), `busy${MSG}`),
      "busy turn running",
    );
    const c0 = sessionFor(h, info.id);
    void h.mgr.sendMessage(info.id, `QUEUED${MSG}`);
    await waitUntil(
      () => queueOf(h, info.id)?.includes(`QUEUED${MSG}`) === true,
      "QUEUED queued",
    );
    h.codexSignedOut.on = true;
    const from = h.logs.length;
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    // The member sees why: the failure line and the engine's sign-in entry
    // (written async, so in either order).
    await waitUntil(
      () =>
        systemLines(h).includes(settingFailedLine()) &&
        h.logs
          .slice(from)
          .some((e) => e.kind === "system" && e.content === SIGN_IN),
      "failure line and sign-in entry",
    );
    // Nothing ran on the signed-out engine, and nothing was lost.
    expect(h.codex.sessions).toHaveLength(0);
    expect(queueOf(h, info.id)).toContain(`QUEUED${MSG}`);

    // Signed in: the next send carries the pointer, and no brief turn is
    // tried again. The member's message releases the queue held for the
    // backend, so QUEUED goes out first, alone.
    h.codexSignedOut.on = false;
    void h.mgr.sendMessage(info.id, `NEXT${MSG}`);
    await waitUntil(
      () => sent(h.codex.lastSession, `QUEUED${MSG}`),
      "the waiting message delivered",
    );
    const s = h.codex.lastSession!;
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text).toContain(`QUEUED${MSG}`);
    expect(s.sent[0].text).toContain(c0.sessionId);
    expect(h.briefs).toHaveLength(0);
    // One-shot: the turn after does not repeat it.
    s.completeTurn({ text: "done" });
    await waitUntil(() => sent(s, `NEXT${MSG}`), "next message sent");
    const next = texts(s).find((t) => t.includes(`NEXT${MSG}`))!;
    expect(next).not.toContain(c0.sessionId);
    expect(texts(s).some((t) => t.includes(BRIEF))).toBe(false);
    expect(h.briefs).toHaveLength(0);
  });

  it("a Stop during the brief turn: no handoff, and the next prompt names the previous conversation", async () => {
    const h = makeHarness({ abortInPlace: true });
    const info = await spawn(h);
    const c0 = await finishedTurn(h, info.id);
    let parked: FakeSession | null = null;
    h.brief.answer = (s) => {
      parked = s;
    };
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(() => parked !== null, "brief turn running");
    const aborted = h.mgr.abort(info.id);
    parked!.completeTurn({ status: "interrupted" });
    expect(await aborted).toMatchObject({ ok: true });
    await waitUntil(
      () => systemLines(h).includes(settingFailedLine()),
      "failure line",
    );
    await settle();
    void h.mgr.sendMessage(info.id, `NEXT${MSG}`);
    await waitUntil(() => sent(parked!, `NEXT${MSG}`), "next message in place");
    const next = texts(parked!).find((t) => t.includes(`NEXT${MSG}`))!;
    expect(next).toContain(c0.sessionId);
    expect(h.briefs).toHaveLength(1);
    expect(allSessions(h).some((s) => sent(s, BRIEF))).toBe(false);
  });
});

describe("two changes in a row", () => {
  it("a change while the brief turn runs: the brief names the first conversation", async () => {
    const blake = memberId("Blake");
    const h = makeHarness();
    const info = await spawn(h);
    const c0 = await finishedTurn(h, info.id);
    // The first brief turn is cut by the second change.
    let first = true;
    h.brief.answer = (s) => {
      if (first) {
        first = false;
        return;
      }
      s.completeTurn({ text: BRIEF });
    };
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(() => h.briefs.length === 1, "first brief turn running");
    await h.mgr.setManager(info.id, blake, "Blake", "Owner");
    await handedOffTo(h, info.id);
    expect(h.briefs).toHaveLength(2);
    expect(h.briefs[1].userId).toBe(blake);
    expect(h.briefs[1].engine).toBe("codex");
    expect(h.briefs[1].names.every((n) => n === c0.sessionId)).toBe(true);
  });

  it("a change after a failed brief turn: the brief names the first conversation", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const c0 = await finishedTurn(h, info.id);
    h.codexSignedOut.on = true;
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(
      () => systemLines(h).includes(settingFailedLine()),
      "failure line",
    );
    h.codexSignedOut.on = false;
    const cwd = join(STATE_ROOT, "tools");
    mkdirSync(cwd, { recursive: true });
    await h.mgr.editAgent(info.id, { cwd });
    await handedOffTo(h, info.id);
    expect(h.briefs).toHaveLength(1);
    expect(h.briefs[0].names.every((n) => n === c0.sessionId)).toBe(true);
  });

  it("a change after the handed-off conversation has worked: the brief names that conversation", async () => {
    const blake = memberId("Blake");
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    const c2 = await handedOffTo(h, info.id);
    // The brief's own turn, then a member's turn in that conversation.
    await waitUntil(
      () => stateOf(h, info.id) === "thinking",
      "brief delivered",
    );
    c2.completeTurn({ text: "on it" });
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    const worked = await finishedTurn(h, info.id, `more${MSG}`);
    expect(worked).toBe(c2);
    await h.mgr.setManager(info.id, blake, "Blake", "Owner");
    await waitUntil(() => h.briefs.length === 2, "second brief turn");
    expect(h.briefs[1].names.every((n) => n === c2.sessionId)).toBe(true);
  });

  it("a change after the pointer went out and the conversation worked: the brief names that conversation", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const c0 = await finishedTurn(h, info.id);
    h.codexSignedOut.on = true;
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(
      () => systemLines(h).includes(settingFailedLine()),
      "failure line",
    );
    h.codexSignedOut.on = false;
    // The pointer goes out with this turn, and the conversation works.
    const c1 = await finishedTurn(h, info.id, `own${MSG}`);
    expect(c1.sent[0].text).toContain(c0.sessionId);
    const cwd = join(STATE_ROOT, "tools");
    mkdirSync(cwd, { recursive: true });
    await h.mgr.editAgent(info.id, { cwd });
    await handedOffTo(h, info.id);
    expect(h.briefs).toHaveLength(1);
    expect(h.briefs[0].names.every((n) => n === c1.sessionId)).toBe(true);
  });

  it("a new conversation after a failed brief turn ends the carry: a later change hands nothing off", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    h.codexSignedOut.on = true;
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(
      () => systemLines(h).includes(settingFailedLine()),
      "failure line",
    );
    h.codexSignedOut.on = false;
    // The member's own boundary.
    await h.mgr.newConversation(info.id);
    const cwd = join(STATE_ROOT, "tools");
    mkdirSync(cwd, { recursive: true });
    await h.mgr.editAgent(info.id, { cwd });
    await settle();
    expect(h.briefs).toHaveLength(0);
    void h.mgr.sendMessage(info.id, `HELLO${MSG}`);
    await waitUntil(
      () => sent(h.codex.lastSession, `HELLO${MSG}`),
      "message delivered",
    );
    expect(h.briefs).toHaveLength(0);
  });
});
