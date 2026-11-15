// A setting change that starts a new conversation hands off (task 1fdda17f):
// the engine, the manager, and the folder of an engine whose session keeps
// its birth folder (Codex). The new conversation, on the NEW settings, runs
// one brief turn that reads the previous conversation from the agent's logs;
// then a fresh session opens on that brief. When the brief turn fails, the
// conversation the change opened stays, and the agent's next prompt names
// the previous conversation instead, and the member's line names the cause.
// A change in the middle of a turn cuts it; the brief turn (or the pointer)
// is told so (task 036e57fe).
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
import {
  AUTO_HANDOFF_FRESH_NOTICE,
  settingHandoffBriefPrompt,
  settingHandoffPointerNotice,
} from "../auto-handoff.ts";
import {
  DEFAULT_AGENT_CAPABILITIES,
  ENGINE_NAMES,
} from "../../shared/types.ts";
import {
  BackendNotConfiguredError,
  type EventHandler,
  type SettingHandoffRequest,
} from "../internal-types.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import {
  createMemberUsageCap,
  memberUsageCap,
  setMemberUsageCapForTests,
} from "../member-usage-cap.ts";
import { WEEK_MS } from "../office-usage.ts";
import type { AgentInfo, LogEntry, RoomWire } from "../../shared/types.ts";

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

const activeFakes: FakeBackend[] = [];
afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
  clearTestManagedOfficeEnv();
  setMemberUsageCapForTests(null);
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
// The provider's error text when it rejects the credentials mid-turn.
const AUTH_REJECTED = "AUTH-REJECTED-401";

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
  engine: "claude" | "codex" | "opencode";
  // The brief prompt as sent.
  text: string;
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
  opencode: FakeBackend;
  logs: LogEntry[];
  briefs: BriefTurn[];
  // How a session answers a brief prompt. Default: completes with BRIEF.
  brief: { answer: (s: FakeSession) => void };
  codexSignedOut: { on: boolean };
  opencodeSignedOut: { on: boolean };
  agentId: { id: string | null };
}

function makeHarness(
  opts: {
    codexAutoHandoff?: boolean;
    abortInPlace?: boolean;
    // The Claude sessions' send parks until releaseSends() (the window
    // before the backend took a message).
    claudeManualSend?: boolean;
    // A closed Claude session's stream stays open until endStream(): the
    // change's drain waits on it.
    claudeHangOnClose?: boolean;
    // The Codex sessions' send parks until releaseSends() or failSends().
    codexManualSend?: boolean;
  } = {},
): Harness {
  const logs: LogEntry[] = [];
  const briefs: BriefTurn[] = [];
  const brief: Harness["brief"] = {
    answer: (s) => s.completeTurn({ text: BRIEF }),
  };
  const codexSignedOut = { on: false };
  const opencodeSignedOut = { on: false };
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
        text,
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
    session: {
      ...session("claude"),
      manualSend: opts.claudeManualSend ?? false,
      hangOnClose: opts.claudeHangOnClose ?? false,
    },
    newSessionId: () => randomUUID(),
  });
  const codex = new FakeBackend({
    session: { ...session("codex"), manualSend: opts.codexManualSend ?? false },
    newSessionId: () => randomUUID(),
    signedOut: () => codexSignedOut.on,
    loginInstructions: { kind: "login", text: SIGN_IN },
    capabilities: {
      ...DEFAULT_AGENT_CAPABILITIES,
      autoHandoff: opts.codexAutoHandoff ?? true,
    },
  });
  const opencode = new FakeBackend({
    session: session("opencode"),
    newSessionId: () => randomUUID(),
    signedOut: () => opencodeSignedOut.on,
    loginInstructions: { kind: "login", text: SIGN_IN },
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES, autoHandoff: true },
  });
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type === "log_entry" && ev.entry) logs.push(ev.entry);
  };
  mgr = createAgentManager({
    resolveBackend: (t) =>
      t === "codex" ? codex : t === "opencode" ? opencode : claude,
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    eventSink: sink,
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(claude, codex, opencode);
  return {
    mgr,
    claude,
    codex,
    opencode,
    logs,
    briefs,
    brief,
    codexSignedOut,
    opencodeSignedOut,
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
const allSessions = (h: Harness) => [
  ...h.claude.sessions,
  ...h.codex.sessions,
  ...h.opencode.sessions,
];
const sessionFor = (h: Harness, id: string) => {
  const own = allSessions(h).filter((s) => s.opts.agentId === id);
  return own[own.length - 1];
};
const queueOf = (h: Harness, id: string) =>
  h.mgr
    .getAllAgents()
    .find((a) => a.id === id)
    ?.queue?.map((m) => m.text);
// The member's line when a setting handoff wrote no brief, one per cause.
// {engine} is the engine the brief turn ran on.
const failedLine = {
  signedOut: (engine: keyof typeof ENGINE_NAMES) =>
    en.t("systemEntries.settingHandoff.failedSignedOut", {
      engine: ENGINE_NAMES[engine],
    }),
  limit: () => en.t("systemEntries.settingHandoff.failedLimit"),
  stopped: () => en.t("systemEntries.settingHandoff.failedStopped"),
  other: () => en.t("systemEntries.settingHandoff.failed"),
};
// Every failure line the member got, whatever its cause.
function failureLines(h: Harness): string[] {
  const all = new Set([
    failedLine.limit(),
    failedLine.stopped(),
    failedLine.other(),
    ...(Object.keys(ENGINE_NAMES) as (keyof typeof ENGINE_NAMES)[]).map(
      failedLine.signedOut,
    ),
  ]);
  return systemLines(h).filter((l) => all.has(l));
}
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

// What `cutTurn` adds to a prompt (the change cut a turn in progress): the
// words of the cut-turn render that the same request without a cut turn
// lacks. The text comes from the prompt functions, so no copy is matched;
// the edge words are dropped, as the strip can split them.
function cutPart(
  render: (r: SettingHandoffRequest) => string,
  previousSessionId: string,
): string {
  const r: SettingHandoffRequest = {
    change: { kind: "engine", from: "claude", to: "codex" },
    previousSessionId,
    cutTurn: false,
  };
  const plain = render(r);
  const cut = render({ ...r, cutTurn: true });
  let pre = 0;
  while (pre < plain.length && plain[pre] === cut[pre]) pre++;
  let suf = 0;
  while (
    suf < plain.length - pre &&
    suf < cut.length - pre &&
    plain[plain.length - 1 - suf] === cut[cut.length - 1 - suf]
  )
    suf++;
  const words = cut.slice(pre, cut.length - suf).split(" ");
  return words.slice(1, -1).join(" ");
}
const briefCut = (agentId: string, previousSessionId: string) =>
  cutPart((r) => settingHandoffBriefPrompt(r, agentId), previousSessionId);
const pointerCut = (previousSessionId: string) =>
  cutPart(settingHandoffPointerNotice, previousSessionId);
// An empty part (the render ignores cutTurn) marks nothing.
const marksCut = (text: string, part: string) =>
  part !== "" && text.includes(part);

// A member turn with a tool call in flight. Returns its session and the
// send's promise.
async function midTurn(
  h: Harness,
  id: string,
  text = `job${MSG}`,
): Promise<{ session: FakeSession; turn: Promise<unknown> }> {
  const turn = h.mgr.sendMessage(id, text);
  await waitUntil(
    () => stateOf(h, id) === "thinking" && sent(sessionFor(h, id), text),
    `turn "${text}" running`,
  );
  const session = sessionFor(h, id);
  session.push({
    kind: "tool_call",
    toolUseId: `tool-${randomUUID()}`,
    name: "Bash",
    input: { command: "sleep 600" },
  });
  await waitUntil(
    () => stateOf(h, id) === "tool_executing",
    "tool call in flight",
  );
  return { session, turn };
}

// The shared success checks: one brief turn, in a fresh session of the
// new settings, that names the previous conversation; then a fresh session
// whose first prompt holds the brief and names the previous conversation
// for its notice.
// The brief prompt marks a cut turn exactly when the change cut one.
async function expectHandedOff(
  h: Harness,
  id: string,
  previous: FakeSession,
  newEngine: BriefTurn["engine"],
  opts: { cut?: boolean } = {},
): Promise<{ brief: BriefTurn; fresh: FakeSession }> {
  const fresh = await handedOffTo(h, id);
  expect(h.briefs).toHaveLength(1);
  const [brief] = h.briefs;
  expect(marksCut(brief.text, briefCut(id, previous.sessionId))).toBe(
    opts.cut ?? false,
  );
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
        systemLines(h).includes(failedLine.signedOut("codex")) &&
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
    // The change cut the busy turn: the pointer says so.
    expect(marksCut(s.sent[0].text, pointerCut(c0.sessionId))).toBe(true);
    expect(failureLines(h)).toEqual([failedLine.signedOut("codex")]);
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
      () => systemLines(h).includes(failedLine.stopped()),
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
    // The second change cut only the first brief turn, not a turn of the
    // conversation the brief reads.
    const part = briefCut(info.id, c0.sessionId);
    expect(marksCut(h.briefs[0].text, part)).toBe(false);
    expect(marksCut(h.briefs[1].text, part)).toBe(false);
  });

  it("a change after a failed brief turn: the brief names the first conversation", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const c0 = await finishedTurn(h, info.id);
    h.codexSignedOut.on = true;
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(
      () => systemLines(h).includes(failedLine.signedOut("codex")),
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
      () => systemLines(h).includes(failedLine.signedOut("codex")),
      "failure line",
    );
    h.codexSignedOut.on = false;
    // The pointer goes out with this turn, and the conversation works.
    const c1 = await finishedTurn(h, info.id, `own${MSG}`);
    expect(c1.sent[0].text).toContain(c0.sessionId);
    // The change came between turns: the pointer marks no cut turn.
    expect(marksCut(c1.sent[0].text, pointerCut(c0.sessionId))).toBe(false);
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
      () => systemLines(h).includes(failedLine.signedOut("codex")),
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

// Nil's sign-off note on 1fdda17f: a change in the middle of a turn. The
// change cuts the turn (no wait for its end), quietly; the brief turn is told
// the last request may be unfinished.
describe("a change in the middle of a turn", () => {
  it("the brief prompt and the pointer notice each add a sentence for a cut turn", () => {
    // A sentence: a few words besides the edge words cutPart drops.
    const id = randomUUID();
    expect(briefCut("agent-x", id).split(" ").length).toBeGreaterThanOrEqual(3);
    expect(pointerCut(id).split(" ").length).toBeGreaterThanOrEqual(3);
  });

  async function expectCutQuietly(
    h: Harness,
    from: number,
    cut: { session: FakeSession; turn: Promise<unknown> },
    sentBefore: number,
  ) {
    let settled = false;
    void cut.turn.finally(() => {
      settled = true;
    });
    await waitUntil(() => settled, "the cut turn's send settled");
    // The cut turn's session got nothing more.
    expect(cut.session.closed).toBe(true);
    expect(cut.session.sent).toHaveLength(sentBefore);
    // No error and no interrupted line for the cut turn, and no failure line.
    const added = h.logs.slice(from);
    expect(added.filter((e) => e.kind === "error").length).toBe(0);
    expect(
      added.filter(
        (e) =>
          e.kind === "system" &&
          e.content === en.t("systemEntries.interrupted"),
      ).length,
    ).toBe(0);
    expect(failureLines(h).length).toBe(0);
  }

  it("engine: one brief turn on the new engine, which is told a turn was cut", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    const cut = await midTurn(h, info.id);
    const sentBefore = cut.session.sent.length;
    const from = h.logs.length;
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    const { fresh } = await expectHandedOff(h, info.id, cut.session, "codex", {
      cut: true,
    });
    expect(h.codex.sessions).toContain(fresh);
    await expectCutQuietly(h, from, cut, sentBefore);
  });

  it("manager: one brief turn under the new manager, which is told a turn was cut", async () => {
    const blake = memberId("Blake");
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    const cut = await midTurn(h, info.id);
    const sentBefore = cut.session.sent.length;
    const from = h.logs.length;
    await h.mgr.setManager(info.id, blake, "Blake", "Owner");
    const { brief } = await expectHandedOff(h, info.id, cut.session, "claude", {
      cut: true,
    });
    expect(brief.userId).toBe(blake);
    await expectCutQuietly(h, from, cut, sentBefore);
  });

  it("folder, Codex: one brief turn in the new folder, which is told a turn was cut", async () => {
    const h = makeHarness();
    const info = await spawn(h, "codex");
    await finishedTurn(h, info.id);
    const cut = await midTurn(h, info.id);
    const sentBefore = cut.session.sent.length;
    const from = h.logs.length;
    const cwd = join(STATE_ROOT, "tools");
    mkdirSync(cwd, { recursive: true });
    await h.mgr.editAgent(info.id, { cwd });
    const { brief } = await expectHandedOff(h, info.id, cut.session, "codex", {
      cut: true,
    });
    expect(brief.session.opts.cwd).toBe(cwd);
    await expectCutQuietly(h, from, cut, sentBefore);
  });

  it("a turn parked on a permission prompt counts as cut", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    const cut = await midTurn(h, info.id);
    cut.session.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "rm -rf build" },
    });
    await waitUntil(
      () => h.mgr.getAgent(info.id)?.pendingPrompt === "permission",
      "parked on the permission prompt",
    );
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    // The change ends the old conversation's prompt with it.
    expect(h.mgr.getAgent(info.id)?.pendingPrompt ?? null).toBe(null);
    await expectHandedOff(h, info.id, cut.session, "codex", { cut: true });
  });

  it("a member's picker parked between turns (/model) is not a cut turn", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const c0 = await finishedTurn(h, info.id);
    await h.mgr.sendMessage(info.id, "/model");
    await waitUntil(
      () => h.mgr.getAgent(info.id)?.pendingPrompt === "model",
      "the /model picker parked",
    );
    // The enabling condition: no turn runs.
    expect(stateOf(h, info.id)).toBe("waiting_for_response");
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await expectHandedOff(h, info.id, c0, "codex", { cut: false });
  });

  it("a member's new conversation drops a parked permission prompt too", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    const cut = await midTurn(h, info.id);
    cut.session.push({
      kind: "approval_request",
      approvalId: "ap-2",
      toolName: "Bash",
      input: { command: "rm -rf build" },
    });
    await waitUntil(
      () => h.mgr.getAgent(info.id)?.pendingPrompt === "permission",
      "parked on the permission prompt",
    );
    await h.mgr.newConversation(info.id);
    expect(h.mgr.getAgent(info.id)?.pendingPrompt ?? null).toBe(null);
    // The next message is a message for the new conversation, not an answer
    // to the dropped prompt.
    void h.mgr.sendMessage(info.id, `HELLO${MSG}`);
    await waitUntil(
      () => sent(sessionFor(h, info.id), `HELLO${MSG}`),
      "message delivered",
    );
    expect(sessionFor(h, info.id)).not.toBe(cut.session);
    expect(cut.session.approvals.length).toBe(0);
    expect(h.briefs).toHaveLength(0);
  });

  it("two changes, the first mid-turn: the second brief is still told a turn was cut", async () => {
    const blake = memberId("Blake");
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    const cut = await midTurn(h, info.id);
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
    const part = briefCut(info.id, cut.session.sessionId);
    expect(marksCut(h.briefs[0].text, part)).toBe(true);
    expect(marksCut(h.briefs[1].text, part)).toBe(true);
    expect(h.briefs[1].names.every((n) => n === cut.session.sessionId)).toBe(
      true,
    );
  });

  it("a send cut before the backend took it reaches the fresh session once, after the brief", async () => {
    const h = makeHarness({ claudeManualSend: true });
    const info = await spawn(h);
    // One finished turn, its send released by hand.
    void h.mgr.sendMessage(info.id, `work${MSG}`);
    await waitUntil(
      () => sent(sessionFor(h, info.id), `work${MSG}`),
      "first send parked",
    );
    const c0 = sessionFor(h, info.id);
    c0.releaseSends();
    c0.completeTurn({ text: "done" });
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest after the turn",
    );
    // The next send waits in the backend's send call when the change comes.
    void h.mgr.sendMessage(info.id, `CUT${MSG}`);
    await waitUntil(() => sent(c0, `CUT${MSG}`), "CUT send parked");
    const edit = h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(() => c0.closed, "the old session closed");
    // The closed session's send fails, as Codex's does ("session is closed").
    c0.failSends(new Error("session is closed"));
    await edit;
    const fresh = await handedOffTo(h, info.id);
    expect(h.briefs).toHaveLength(1);
    expect(h.briefs[0].text).not.toContain(`CUT${MSG}`);
    expect(sent(h.briefs[0].session, `CUT${MSG}`)).toBe(false);
    await waitUntil(() => sent(fresh, `CUT${MSG}`), "CUT delivered");
    const all = h.codex.sessions.flatMap((s) => texts(s));
    expect(all.filter((t) => t.includes(`CUT${MSG}`))).toHaveLength(1);
    // After the brief, in the fresh conversation.
    expectInOrder(texts(fresh).join("\n"), [BRIEF, `CUT${MSG}`]);
    expect(h.logs.filter((e) => e.kind === "error").length).toBe(0);
  });
});

// Nil's sign-off comment on 1fdda17f: the failure line says why no brief was
// written. One line per failure, by cause.
describe("a brief turn that fails: the member's line names the cause", () => {
  // The change and its failure; returns the previous conversation.
  async function failedChange(
    h: Harness,
    id: string,
    change: () => Promise<unknown>,
    expected: string,
  ): Promise<void> {
    await change();
    await waitUntil(() => failureLines(h).length > 0, "a failure line");
    await settle();
    expect(failureLines(h)).toEqual([expected]);
    expect(allSessions(h).some((s) => sent(s, BRIEF))).toBe(false);
    expect(h.mgr.getAgent(id)).toBeDefined();
  }

  it("the new engine is signed out: the line names that engine (OpenCode)", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    h.opencodeSignedOut.on = true;
    await failedChange(
      h,
      info.id,
      () => h.mgr.editAgent(info.id, { agentType: "opencode" }),
      failedLine.signedOut("opencode"),
    );
    expect(h.opencode.sessions).toHaveLength(0);
  });

  it("the engine's usage limit stops the brief turn", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    h.brief.answer = (s) => {
      s.push({ kind: "assistant_text", text: "BRIEF-PART" });
      s.push({
        kind: "usage_limit_stop",
        resetsAtMs: Date.now() + 60 * 60 * 1000,
      });
      s.completeTurn();
    };
    await failedChange(
      h,
      info.id,
      () => h.mgr.editAgent(info.id, { agentType: "codex" }),
      failedLine.limit(),
    );
    expect(h.briefs).toHaveLength(1);
  });

  it("the new manager's usage cap refuses the brief turn", async () => {
    const blake = memberId("Blake");
    const claudeHome = join(STATE_ROOT, "claude-home");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    setMemberUsageCapForTests(
      createMemberUsageCap({
        reader: {
          async read() {
            return {
              kind: "weekly",
              usedPercent: 90,
              resetsAtMs: Date.now() + WEEK_MS / 2,
              observedAtMs: Date.now(),
            };
          },
          invalidate() {},
          close() {},
        },
        officeDir: () => claudeHome,
        load: () => true,
      }),
    );
    await failedChange(
      h,
      info.id,
      () => h.mgr.setManager(info.id, blake, "Blake", "Owner"),
      failedLine.limit(),
    );
    expect(h.briefs).toHaveLength(0);
  });

  it("the new engine rejects the credentials during the brief turn", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    // As the engines report it: auth_needed (backends/auth-signal.ts), then
    // the error and the failed turn.
    h.brief.answer = (s) => {
      s.push({ kind: "auth_needed" });
      s.push({ kind: "error", message: `${AUTH_REJECTED}: invalid token` });
      s.completeTurn({ status: "failed", error: AUTH_REJECTED });
    };
    await failedChange(
      h,
      info.id,
      () => h.mgr.editAgent(info.id, { agentType: "codex" }),
      failedLine.signedOut("codex"),
    );
    // The enabling conditions: the brief turn ran (it was not refused before
    // its send), and the member got the engine's sign-in entry.
    expect(h.briefs).toHaveLength(1);
    expect(
      h.logs.some((e) => e.kind === "system" && e.content === SIGN_IN),
    ).toBe(true);
  });

  it("the new engine needs sign-in and ends the brief turn with no error", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    // auth_needed, then a failed end with no error event: nothing throws.
    h.brief.answer = (s) => {
      s.push({ kind: "auth_needed" });
      s.completeTurn({ status: "failed" });
    };
    await failedChange(
      h,
      info.id,
      () => h.mgr.editAgent(info.id, { agentType: "codex" }),
      failedLine.signedOut("codex"),
    );
    expect(h.briefs).toHaveLength(1);
    expect(
      h.logs.some((e) => e.kind === "system" && e.content === SIGN_IN),
    ).toBe(true);
  });

  it("the new engine is not set up (not installed): the line names that engine", async () => {
    const h = makeHarness({ codexManualSend: true });
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    // As the Codex adapter fails when its CLI is missing: the send throws.
    h.brief.answer = (s) =>
      s.failSends(
        new BackendNotConfiguredError("Codex CLI not found.", "npm i codex"),
      );
    await failedChange(
      h,
      info.id,
      () => h.mgr.editAgent(info.id, { agentType: "codex" }),
      failedLine.signedOut("codex"),
    );
    // The enabling conditions: the brief turn reached its send, and this is
    // not the sign-in path (no sign-in entry).
    expect(h.briefs).toHaveLength(1);
    expect(
      h.logs.some((e) => e.kind === "system" && e.content === SIGN_IN),
    ).toBe(false);
  });

  it("the usage cap refuses the handoff after the brief was written", async () => {
    const blake = memberId("Blake");
    const claudeHome = join(STATE_ROOT, "claude-home");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
    const used = { percent: 1 };
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    setMemberUsageCapForTests(
      createMemberUsageCap({
        reader: {
          async read() {
            return {
              kind: "weekly",
              usedPercent: used.percent,
              resetsAtMs: Date.now() + WEEK_MS / 2,
              observedAtMs: Date.now(),
            };
          },
          invalidate() {},
          close() {},
        },
        officeDir: () => claudeHome,
        load: () => true,
      }),
    );
    // The brief turn is admitted; while it runs, the office goes over the
    // line, and the handoff's own check refuses.
    h.brief.answer = (s) => {
      void (async () => {
        used.percent = 90;
        memberUsageCap().invalidate("claude");
        await h.mgr.prepareEnqueue(info.id);
        s.completeTurn({ text: BRIEF });
      })();
    };
    await failedChange(
      h,
      info.id,
      () => h.mgr.setManager(info.id, blake, "Blake", "Owner"),
      failedLine.limit(),
    );
    // The enabling condition: the brief was written.
    expect(h.briefs).toHaveLength(1);
    expect(
      h.logs.some((e) => e.kind === "text" && e.content.includes(BRIEF)),
    ).toBe(true);
  });

  it("a Stop during the brief turn on an engine that cannot stop in place", async () => {
    const h = makeHarness({ abortInPlace: false });
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    let parked: FakeSession | null = null;
    h.brief.answer = (s) => {
      parked = s;
    };
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(() => parked !== null, "brief turn running");
    expect(parked!.canAbortInPlace()).toBe(false);
    await h.mgr.abort(info.id);
    await waitUntil(() => failureLines(h).length > 0, "a failure line");
    await settle();
    expect(failureLines(h)).toEqual([failedLine.stopped()]);
  });

  it("a Stop before the brief turn starts", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    const cut = await midTurn(h, info.id);
    // The Stop arrives while the conversation the change opened starts:
    // after the change armed the handoff, before the brief turn runs.
    const create = h.codex.createSession.bind(h.codex);
    let stopped: Promise<unknown> | null = null;
    h.codex.createSession = (o) => {
      if (!stopped) stopped = h.mgr.abort(info.id);
      return create(o);
    };
    await h.mgr.editAgent(info.id, { agentType: "codex" });
    await waitUntil(() => stopped !== null, "the Stop sent");
    await stopped;
    await waitUntil(() => failureLines(h).length > 0, "a failure line");
    await settle();
    expect(failureLines(h)).toEqual([failedLine.stopped()]);
    expect(h.briefs).toHaveLength(0);
    // The pointer goes out with the next message, and marks the cut turn.
    void h.mgr.sendMessage(info.id, `NEXT${MSG}`);
    await waitUntil(
      () => sent(h.codex.lastSession, `NEXT${MSG}`),
      "next message sent",
    );
    const next = texts(h.codex.lastSession).find((t) =>
      t.includes(`NEXT${MSG}`),
    )!;
    expect(next).toContain(cut.session.sessionId);
    expect(marksCut(next, pointerCut(cut.session.sessionId))).toBe(true);
  });

  it("a brief turn that fails for another reason gives the plain line", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    h.brief.answer = (s) =>
      s.completeTurn({ status: "failed", error: "model exploded" });
    await failedChange(
      h,
      info.id,
      () => h.mgr.editAgent(info.id, { agentType: "codex" }),
      failedLine.other(),
    );
  });

  it("a brief turn that writes no brief gives the plain line", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    h.brief.answer = (s) => s.completeTurn({});
    await failedChange(
      h,
      info.id,
      () => h.mgr.editAgent(info.id, { agentType: "codex" }),
      failedLine.other(),
    );
  });
});
