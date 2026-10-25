// Automatic handoff (internal-docs/auto-handoff-design.md). Seam: the DI
// manager (createAgentManager + FakeBackend). A member's message starts each
// turn and parks it until the test completes it; getContextUsage reports the
// value the test sets, so the test decides what the crossing turn measured.
// The brief turn is answered by the fake session as soon as it is sent.
// The crossing turn only arms the mode: its reply stays on screen, and the
// next message to arrive starts the brief turn (Nil, 2026-10-15).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { blockAtomicFileReplacement, removeStateDir } from "./temp-state.ts";
import { createAgentManager, type LimitResumeClock } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { translatorForLanguage } from "../i18n.ts";
import { createMember, getUserByName } from "../users.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import {
  AUTO_HANDOFF_FRESH_NOTICE,
  autoHandoffTrigger,
} from "../auto-handoff.ts";
import { officeAuditStore } from "../audit-store.ts";
import {
  createMemberUsageCap,
  memberUsageCap,
  setMemberUsageCapForTests,
} from "../member-usage-cap.ts";
import { WEEK_MS } from "../office-usage.ts";
import { limitResumeOn } from "../limit-resume.ts";
import { loadAgents } from "../persistence.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import type { ContextUsage } from "../backends/types.ts";
import type { EventHandler } from "../internal-types.ts";
import type {
  AgentInfo,
  LogEntry,
  QueuedMessage,
  RoomWire,
  UserRole,
} from "../../shared/types.ts";

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

const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];
const SENDER: QueuedMessage["sender"] = {
  kind: "agent",
  agentId: "agent-sender",
  agentName: "Sender",
  roomName: "room-a",
};
const en = translatorForLanguage("en");
const BRIEF = "BRIEF-TEXT: finish step 4, then report.";
// The brief turn's prompt opens with this; a member's message never does.
const isBriefPrompt = (text: string) =>
  text.includes("[automatic handoff: your context is at");

// `compactAt` the way each engine reports it: Claude's SDK threshold, or the
// internal compactAtTokens an adapter (OpenCode) fills.
function ctx(
  totalTokens: number,
  maxTokens: number,
  compactAt?: number,
  via: "sdk" | "adapter" = "sdk",
): ContextUsage {
  return {
    model: "fake-model",
    totalTokens,
    maxTokens,
    percentage: (totalTokens / maxTokens) * 100,
    ...(compactAt === undefined
      ? {}
      : via === "sdk"
        ? { isAutoCompactEnabled: true, autoCompactThreshold: compactAt }
        : { compactAtTokens: compactAt }),
  };
}

interface Harness {
  mgr: ReturnType<typeof createAgentManager>;
  fake: FakeBackend;
  logs: LogEntry[];
  // What the next getContextUsage reports.
  measure: { now: ContextUsage | null; delayMs?: number };
  // How the fake session answers the brief prompt.
  brief: { answer: (s: FakeSession) => void };
}

function makeHarness(
  opts: {
    abortInPlace?: boolean;
    toolBoundaryDelivery?: boolean;
    // A transcript holding one member message "work", so it can be edited.
    editable?: boolean;
    // How long a send waits for the last turn's sample (production: 500 ms).
    sampleWaitMs?: number;
    limitResumeClock?: LimitResumeClock;
  } = {},
): Harness {
  const measure: Harness["measure"] = { now: null };
  const brief: Harness["brief"] = {
    answer: (s) => s.completeTurn({ text: BRIEF }),
  };
  const fake = new FakeBackend({
    ...(opts.toolBoundaryDelivery ? { toolBoundaryDelivery: true } : {}),
    ...(opts.editable
      ? {
          forkResult: {
            kind: "fork" as const,
            sessionId: "forked-1",
            forkedFromSessionId: "fake-session-1",
          },
          sessionMessages: [
            { uuid: "u-1", role: "user" as const, text: "work" },
            { uuid: "a-1", role: "assistant" as const, text: "done" },
          ],
        }
      : {}),
    session: {
      abortInPlace: opts.abortInPlace ?? false,
      contextUsage: async () => {
        const now = measure.now;
        if (measure.delayMs) await sleep(measure.delayMs);
        return now;
      },
      onSend: (text, _a, s) => {
        // A timer, not a microtask: a mutant that loops brief turns must
        // leave the test's own timers able to fire and report it.
        if (isBriefPrompt(text)) setTimeout(() => brief.answer(s), 0);
      },
    },
  });
  const logs: LogEntry[] = [];
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type === "log_entry" && ev.entry) logs.push(ev.entry);
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    eventSink: sink,
    ...(opts.limitResumeClock
      ? { limitResumeClock: opts.limitResumeClock }
      : {}),
  });
  mgr.configureAgentTurnDeps(opts.sampleWaitMs);
  activeFakes.push(fake);
  return { mgr, fake, logs, measure, brief };
}

// The user store outlives the state dir reset in a multi-file run, so a
// name another file seeds can come back with another role: use names only
// this file uses.
function userIdFor(name: string, role: UserRole): string {
  const existing = getUserByName(name);
  if (existing) {
    if (existing.role !== role)
      throw new Error(`${name} exists with role ${existing.role}`);
    return existing.id;
  }
  const created = createMember(name, { role });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}

async function spawn(
  h: Harness,
  opts: {
    autoHandoff?: boolean;
    agentType?: AgentInfo["agentType"];
    manager?: { name: string; role: UserRole };
  } = {},
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
    opts.manager?.name,
    opts.agentType ?? "claude",
    undefined,
    opts.manager ? userIdFor(opts.manager.name, opts.manager.role) : undefined,
  );
  if (!info) throw new Error("spawn returned null");
  // On by default: a spawned agent stores no switch and hands off.
  if (opts.autoHandoff === false)
    await h.mgr.editAgent(info.id, { autoHandoff: false });
  return info;
}

const stateOf = (h: Harness, id: string) => h.mgr.getAgent(id)?.state;
const texts = (s: FakeSession | undefined) =>
  (s?.sent ?? []).map((m) => m.text);
// Whether the session got `text`, bare or after the notice envelope.
const got = (s: FakeSession | undefined, text: string) =>
  texts(s).some((t) => t === text || t.endsWith(`\nUser message:\n${text}`));
const systemLines = (h: Harness) =>
  h.logs.filter((e) => e.kind === "system").map((e) => e.content);
// Whether the member's context-fullness notice at `percent` was written: a
// catalog message with the percent as its parameter (task ef6b1c31).
const contextNoticeAt = (h: Harness, percent: number) =>
  h.logs.some(
    (e) =>
      e.kind === "system" &&
      (e.message ?? []).some(
        (part) =>
          typeof part !== "string" &&
          part.key === "systemEntries.contextFull" &&
          part.params?.percent === percent,
      ),
  );

// How many log entries (any kind) carry the catalog message `key`.
const keyCount = (h: Harness, key: string) =>
  h.logs.filter((e) =>
    (e.message ?? []).some(
      (part) => typeof part !== "string" && part.key === key,
    ),
  ).length;
const RETRY_KEY = "systemEntries.autoHandoff.retry";
const CAP_KEY = "systemEntries.usageCap.pace";

// A failed automatic attempt that stays open: the retry line, not the
// failure line, and the wrap-up notice stays quiet (95% is the measured
// context in these tests). `old` got `briefs` brief prompts: the brief turn's
// own end is not the completed turn a retry waits for, so none follows it.
async function expectAttemptOpen(
  h: Harness,
  old: FakeSession,
  briefs: number,
): Promise<void> {
  const failed = en.t("systemEntries.autoHandoff.failed");
  await waitUntil(
    () =>
      keyCount(h, RETRY_KEY) > 0 ||
      systemLines(h).includes(failed) ||
      h.fake.sessions.length > 1,
    "the attempt ended (retry line, failure line or handoff)",
  );
  await settle();
  expect(h.fake.sessions).toHaveLength(1);
  expect(systemLines(h)).not.toContain(failed);
  expect(texts(old).filter(isBriefPrompt)).toHaveLength(briefs);
  expect(keyCount(h, RETRY_KEY)).toBe(1);
  expect(contextNoticeAt(h, 95)).toBe(false);
}

// An open attempt tries again: the turn running in the old session (the
// message the failed attempt released) completes above the trigger, and the
// next message hands off. 96%, so the commit of this turn's sample is seen
// apart from the earlier 95% one.
async function expectRetried(
  h: Harness,
  id: string,
  old: FakeSession,
  running: string,
): Promise<FakeSession> {
  await waitUntil(
    () => stateOf(h, id) === "thinking" && sent(old, running),
    "released message runs in the old session",
  );
  h.measure.now = ctx(192_000, 200_000);
  old.completeTurn({ text: "done" });
  await nextMessage(h, id, "RETRY-NEXT");
  const fresh = await freshSession(h, id, old);
  expect(texts(old).filter(isBriefPrompt)).toHaveLength(2);
  expectInOrder(fresh.sent[0].text, [BRIEF, "RETRY-NEXT"]);
  return fresh;
}

// The member usage cap on the office account, which the agents bill
// (CLAUDE_CONFIG_DIR). `used` is the weekly percent each read reports: 1 is
// under today's line, 90 over it. flipAfterNextRead: the next read still
// reports `used`, every later one 90.
function capOn(): { used: number; flipAfterNextRead: boolean } {
  const claudeHome = join(STATE_ROOT, "claude-home");
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
  const state = { used: 1, flipAfterNextRead: false };
  setMemberUsageCapForTests(
    createMemberUsageCap({
      reader: {
        async read() {
          const usedPercent = state.used;
          if (state.flipAfterNextRead) {
            state.flipAfterNextRead = false;
            state.used = 90;
          }
          return {
            kind: "weekly",
            usedPercent,
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
  return state;
}

// Start a member turn and wait until the session runs it.
async function startTurn(
  h: Harness,
  id: string,
  text = "work",
): Promise<FakeSession> {
  void h.mgr.sendMessage(id, text);
  await waitUntil(
    () =>
      stateOf(h, id) === "thinking" && got(h.fake.sessionForAgent(id), text),
    `turn "${text}" running`,
  );
  return h.fake.sessionForAgent(id)!;
}

// One member turn that ends with the context at `usage`.
async function turnEndingAt(
  h: Harness,
  id: string,
  usage: ContextUsage | null,
  status: "completed" | "interrupted" | "failed" = "completed",
): Promise<FakeSession> {
  const s = await startTurn(h, id);
  h.measure.now = usage;
  s.completeTurn({ text: "done", status });
  return s;
}

// The session after `old`, once it has its first prompt.
async function freshSession(
  h: Harness,
  id: string,
  old: FakeSession,
): Promise<FakeSession> {
  await waitUntil(() => {
    const cur = h.fake.sessionForAgent(id);
    return !!cur && cur !== old && cur.sent.length > 0;
  }, "fresh session received its first prompt");
  return h.fake.sessionForAgent(id)!;
}

// Long enough for a sample, a brief turn and a reset that are NOT supposed to
// happen to have happened.
const settle = () => sleep(150);

const NEXT = "NEXT-MESSAGE";
const sent = (s: FakeSession | undefined, needle: string) =>
  texts(s).some((t) => t.includes(needle));

// At rest after a turn, with the sample the test set committed: arming is
// decided in that commit, so from here the agent is armed or it is not.
async function atRestMeasured(h: Harness, id: string): Promise<void> {
  const tokens = h.measure.now?.totalTokens;
  await waitUntil(
    () =>
      stateOf(h, id) === "waiting_for_response" &&
      h.mgr.getAgent(id)?.contextUsage?.totalTokens === tokens,
    "at rest with the turn's sample committed",
  );
}

// After a crossing turn, a member's message arrives. That the armed agent
// rests with no brief turn and no reset until then is checked once per kind
// of message ("the next message starts it").
async function nextMessage(h: Harness, id: string, text = NEXT) {
  await atRestMeasured(h, id);
  void h.mgr.sendMessage(id, text);
}

function expectInOrder(text: string, needles: string[]) {
  const at = needles.map((n) => text.indexOf(n));
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
}

describe("automatic handoff: arming", () => {
  for (const agentType of ["claude", "codex", "opencode"] as const) {
    it(`${agentType}: 85% of a small window hands off, with the brief captured after the last tool call`, async () => {
      const h = makeHarness();
      // OpenCode streams deltas; the other engines send whole blocks.
      const chunks =
        agentType === "opencode"
          ? ["BRIEF-TEXT: fin", "ish step 4."]
          : ["BRIEF-TEXT: finish step 4.", "Then report."];
      const captured =
        agentType === "opencode"
          ? "BRIEF-TEXT: finish step 4."
          : "BRIEF-TEXT: finish step 4.\n\nThen report.";
      h.brief.answer = (s) => {
        s.push({ kind: "assistant_text", text: "Checking first." });
        s.push({
          kind: "tool_call",
          toolUseId: "t1",
          name: "Bash",
          input: { command: "git status" },
        });
        s.push({ kind: "tool_result", toolUseId: "t1", content: "clean" });
        for (const text of chunks) s.push({ kind: "assistant_text", text });
        s.completeTurn();
      };
      const info = await spawn(h, { agentType });
      const old = await turnEndingAt(h, info.id, ctx(172_000, 200_000));
      await nextMessage(h, info.id);

      const fresh = await freshSession(h, info.id, old);
      // The brief turn ran in the old session, with nothing else.
      expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
      expect(texts(old).at(-1)).toContain("172,000 tokens (86% full)");
      expect(sent(old, NEXT)).toBe(false);
      // The fresh session got the notice, then the brief from the old one,
      // then the message that started the handoff.
      const first = fresh.sent[0].text;
      expectInOrder(first, [
        "--- begin isomux: auto-handoff ---",
        AUTO_HANDOFF_FRESH_NOTICE,
        "[Handoff from your previous session]",
        captured,
        NEXT,
      ]);
      expect(first).not.toContain("Checking first.");
      // Both lines name the 85% limit, not the 86% measured.
      expect(systemLines(h)).toContain(
        en.t("systemEntries.autoHandoff.writingPercent", { percent: 85 }),
      );
      expect(systemLines(h)).toContain(
        en.t("systemEntries.autoHandoff.donePercent", { percent: 85 }),
      );
      // The brief turn's own sample, still above the trigger, does not start
      // a second attempt in either session.
      await settle();
      expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
      expect(h.fake.sessions).toHaveLength(2);
      expect(texts(fresh).some(isBriefPrompt)).toBe(false);
      // The fresh chat starts with that line, not the line of a new
      // conversation or of a manual handoff.
      expect(systemLines(h)).not.toContain(
        en.t("systemEntries.newConversation"),
      );
      expect(systemLines(h)).not.toContain(en.t("systemEntries.handedOff"));
    });
  }

  it("500k tokens of a 1M window hands off before 85%, with no 50% notice to either audience", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(510_000, 1_000_000));
    await nextMessage(h, info.id);
    await freshSession(h, info.id, old);
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.writingTokens", { thousands: 500 }),
    );
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.doneTokens", { thousands: 500 }),
    );
    // The arming sample is past the 50 band: neither the member line nor the
    // agent's context check.
    expect(contextNoticeAt(h, 51)).toBe(false);
    expect(texts(old).join("\n")).not.toContain("context-check");
  });

  for (const [agentType, via] of [
    ["claude", "sdk"],
    ["opencode", "adapter"],
  ] as const) {
    it(`${agentType}: an engine that compacts before 85% hands off 5 points ahead of its compaction point`, async () => {
      // Compacts at 160k of 200k (80%): the trigger is 75%, 150k.
      expect(
        autoHandoffTrigger({ maxTokens: 200_000, compactAtTokens: 160_000 }),
      ).toMatchObject({ tokens: 150_000, measure: "compaction" });
      const h = makeHarness();
      const info = await spawn(h, { agentType });
      // Below the guard: nothing.
      await turnEndingAt(h, info.id, ctx(149_000, 200_000, 160_000, via));
      await settle();
      const old = h.fake.sessionForAgent(info.id)!;
      expect(texts(old).some(isBriefPrompt)).toBe(false);
      // At the guard: hands off.
      await waitUntil(
        () => stateOf(h, info.id) === "waiting_for_response",
        "at rest",
      );
      await turnEndingAt(h, info.id, ctx(152_000, 200_000, 160_000, via));
      await nextMessage(h, info.id);
      await freshSession(h, info.id, old);
      expect(systemLines(h)).toContain(
        en.t("systemEntries.autoHandoff.writingCompaction", { percent: 75 }),
      );
      expect(systemLines(h)).toContain(
        en.t("systemEntries.autoHandoff.doneCompaction", { percent: 75 }),
      );
    });
  }

  it("with the switch off, nothing changes: no brief turn, no reset, and both wrap-up notices show", async () => {
    const h = makeHarness();
    const info = await spawn(h, { autoHandoff: false });
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await waitUntil(() => contextNoticeAt(h, 95), "member wrap-up notice");
    await atRestMeasured(h, info.id);
    // The next message runs in place, with the agent's wrap-up advice.
    const s = await startTurn(h, info.id, "next");
    expect(s).toBe(old);
    expect(texts(s).at(-1)).toContain("--- begin isomux: context-check ---");
    expect(h.fake.sessions).toHaveLength(1);
    expect(texts(old).some(isBriefPrompt)).toBe(false);
  });

  it("an engine that reports no measure arms nothing", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await turnEndingAt(h, info.id, null);
    await settle();
    expect(h.fake.sessions).toHaveLength(1);
    expect(texts(h.fake.sessions[0]).some(isBriefPrompt)).toBe(false);
  });

  it("a turn the member stops does not arm, even above the trigger", async () => {
    // An in-place abort: the session stays and its turn ends "interrupted",
    // leaving the agent at rest rather than in error.
    const h = makeHarness({ abortInPlace: true });
    const info = await spawn(h);
    const s = await startTurn(h, info.id);
    h.measure.now = ctx(190_000, 200_000);
    const aborted = h.mgr.abort(info.id);
    s.completeTurn({ status: "interrupted" });
    expect(await aborted).toMatchObject({ ok: true });
    await settle();
    expect(stateOf(h, info.id)).toBe("waiting_for_response");
    // Armed, the next message would wait for a brief turn; unarmed, it goes
    // straight to the session.
    void h.mgr.sendMessage(info.id, "next");
    await waitUntil(() => got(s, "next"), "next message delivered");
    expect(texts(s).some(isBriefPrompt)).toBe(false);
  });

  it("a mid-turn usage_update sample does not arm; the completed turn's sample does", async () => {
    const h = makeHarness();
    const info = await spawn(h, { agentType: "codex" });
    const usageUpdate = (s: FakeSession) =>
      s.push({
        kind: "usage_update",
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      });
    const committed = (tokens: number) =>
      h.mgr.getAgent(info.id)?.contextUsage?.totalTokens === tokens;

    // Above the trigger mid-turn, below it when the turn ends: no handoff.
    const s = await startTurn(h, info.id);
    h.measure.now = ctx(190_000, 200_000);
    usageUpdate(s);
    await waitUntil(() => committed(190_000), "mid-turn sample committed");
    h.measure.now = ctx(160_000, 200_000);
    s.completeTurn({ text: "done" });
    await waitUntil(() => committed(160_000), "turn-end sample committed");
    await settle();
    expect(texts(s).some(isBriefPrompt)).toBe(false);

    // A turn-end sample equal to the last mid-turn one still commits and arms.
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    // Not armed by the first half: this message runs in the same session.
    await startTurn(h, info.id);
    expect(texts(s).some(isBriefPrompt)).toBe(false);
    h.measure.now = ctx(190_000, 200_000);
    usageUpdate(s);
    await waitUntil(() => committed(190_000), "second mid-turn sample");
    s.completeTurn({ text: "done" });
    await nextMessage(h, info.id);
    await freshSession(h, info.id, s);
    expect(texts(s).filter(isBriefPrompt)).toHaveLength(1);
  });
});

describe("automatic handoff: the agent's own token value", () => {
  it("arms at exactly that value, and both lines name it", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await h.mgr.editAgent(info.id, { autoHandoffTokens: 300_000 });
    // One token under it: nothing arms.
    const old = await turnEndingAt(h, info.id, ctx(299_999, 1_000_000));
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await settle();
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    // At it: the next message starts the handoff.
    await turnEndingAt(h, info.id, ctx(300_000, 1_000_000));
    await nextMessage(h, info.id);
    await freshSession(h, info.id, old);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.writingTokens", { thousands: 300 }),
    );
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.doneTokens", { thousands: 300 }),
    );
  });

  // Armed at 510k of 1M by the default 500k; the edit lands before the brief
  // turn starts.
  async function armedAt510k(h: Harness): Promise<{
    info: AgentInfo;
    old: FakeSession;
  }> {
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(510_000, 1_000_000));
    await atRestMeasured(h, info.id);
    return { info, old };
  }

  it("an edit while armed that leaves the context above the value keeps it armed, and the lines name the new value", async () => {
    const h = makeHarness();
    const { info, old } = await armedAt510k(h);
    await h.mgr.editAgent(info.id, { autoHandoffTokens: 505_000 });
    await nextMessage(h, info.id);
    const fresh = await freshSession(h, info.id, old);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
    expect(sent(fresh, NEXT)).toBe(true);
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.writingTokens", { thousands: 505 }),
    );
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.doneTokens", { thousands: 505 }),
    );
  });

  it("an edit while armed that raises the value past the context disarms it, and the next message runs in place", async () => {
    const h = makeHarness();
    const { info, old } = await armedAt510k(h);
    await h.mgr.editAgent(info.id, { autoHandoffTokens: 600_000 });
    await nextMessage(h, info.id);
    await waitUntil(() => sent(old, NEXT), "message runs in the old session");
    await settle();
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);
  });

  // An edit with the context already at or above the new value arms at once
  // (task f2f8488d): the next message starts the handoff.

  // At rest at 471k of 1M, under the default 500k: the turn armed nothing.
  async function restingAt471k(h: Harness): Promise<{
    info: AgentInfo;
    old: FakeSession;
  }> {
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(471_000, 1_000_000));
    await atRestMeasured(h, info.id);
    return { info, old };
  }

  // One message: the brief turn runs in `old`, and the message goes to the
  // fresh session after the brief.
  async function nextMessageHandsOff(
    h: Harness,
    id: string,
    old: FakeSession,
  ): Promise<void> {
    await nextMessage(h, id);
    const fresh = await freshSession(h, id, old);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
    expect(sent(old, NEXT)).toBe(false);
    expectInOrder(fresh.sent[0].text, [BRIEF, NEXT]);
  }

  it("an edit that lowers the value below the context arms it, and one message starts the handoff", async () => {
    const h = makeHarness();
    const { info, old } = await restingAt471k(h);
    await h.mgr.editAgent(info.id, { autoHandoffTokens: 300_000 });
    await nextMessageHandsOff(h, info.id, old);
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.writingTokens", { thousands: 300 }),
    );
  });

  it("turning the switch on with the context above the value arms it", async () => {
    const h = makeHarness();
    const info = await spawn(h, { autoHandoff: false });
    const old = await turnEndingAt(h, info.id, ctx(600_000, 1_000_000));
    await atRestMeasured(h, info.id);
    await h.mgr.editAgent(info.id, { autoHandoff: true });
    await nextMessageHandsOff(h, info.id, old);
  });

  it("the sample an edit arms from may come from a turn the member stopped", async () => {
    const h = makeHarness({ abortInPlace: true });
    const info = await spawn(h);
    const s = await startTurn(h, info.id);
    h.measure.now = ctx(471_000, 1_000_000);
    const aborted = h.mgr.abort(info.id);
    s.completeTurn({ status: "interrupted" });
    expect(await aborted).toMatchObject({ ok: true });
    await atRestMeasured(h, info.id);
    await h.mgr.editAgent(info.id, { autoHandoffTokens: 300_000 });
    await nextMessageHandsOff(h, info.id, s);
  });

  it("an edit that lowers the value, then one that raises it past the context: the next message runs in place", async () => {
    const h = makeHarness();
    const { info, old } = await restingAt471k(h);
    await h.mgr.editAgent(info.id, { autoHandoffTokens: 300_000 });
    await h.mgr.editAgent(info.id, { autoHandoffTokens: 700_000 });
    await nextMessage(h, info.id);
    await waitUntil(() => sent(old, NEXT), "message runs in the old session");
    await settle();
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);
  });

  it("an edit after the loop guard paused the mode arms nothing", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    const fresh = await freshSession(h, info.id, old);
    h.measure.now = ctx(185_000, 200_000);
    fresh.completeTurn({ text: "resumed" });
    const paused = en.t("systemEntries.autoHandoff.paused");
    await waitUntil(() => systemLines(h).includes(paused), "pause line");
    await atRestMeasured(h, info.id);
    await h.mgr.editAgent(info.id, { autoHandoffTokens: 100_000 });
    await nextMessage(h, info.id, "AFTER-EDIT");
    await waitUntil(() => sent(fresh, "AFTER-EDIT"), "message runs in place");
    await settle();
    expect(texts(fresh).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessions).toHaveLength(2);
  });

  it("one edit that changes the model and lowers the value arms nothing: the old model's sample no longer counts", async () => {
    const h = makeHarness();
    const { info } = await restingAt471k(h);
    await h.mgr.editAgent(info.id, {
      modelFamily: "haiku",
      autoHandoffTokens: 300_000,
    });
    // The enabling condition: the edit changed the model and dropped the
    // sample.
    expect(h.mgr.getAgent(info.id)?.modelFamily).toBe("haiku");
    expect(h.mgr.getAgent(info.id)?.contextUsage ?? null).toBeNull();
    void h.mgr.sendMessage(info.id, NEXT);
    await waitUntil(
      () => h.fake.sessions.some((s) => sent(s, NEXT)),
      "message delivered",
    );
    await settle();
    expect(h.fake.sessions.some((s) => texts(s).some(isBriefPrompt))).toBe(
      false,
    );
    expect(h.fake.sessionForAgent(info.id)?.isResume).toBe(true);
  });
});

describe("automatic handoff: the next message starts it", () => {
  // A scheduled or cron message enqueues like an agent's message and meets
  // the same flushQueue gate, so the agent's message stands for them.
  const kinds: {
    name: string;
    send: (h: Harness, id: string) => void;
    // What the fresh session's first prompt carries for that message.
    marker: string;
  }[] = [
    {
      name: "a member's message",
      send: (h, id) => void h.mgr.sendMessage(id, "MEMBER-NEXT"),
      marker: "MEMBER-NEXT",
    },
    {
      name: "an agent's message",
      send: (h, id) =>
        void h.mgr.enqueueMessage(id, { sender: SENDER, text: "AGENT-NEXT" }),
      marker: "AGENT-NEXT",
    },
    {
      name: "a member's skill",
      send: (h, id) => void h.mgr.sendMessage(id, "/nextskill"),
      marker: "NEXT-SKILL-BODY",
    },
  ];
  for (const kind of kinds) {
    it(`${kind.name} after the crossing turn starts the handoff and goes to the fresh session after the brief`, async () => {
      const skillDir = join(STATE_ROOT, "skills", "nextskill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "NEXT-SKILL-BODY");
      const h = makeHarness();
      const info = await spawn(h);
      const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
      // Armed at rest: the reply stays, with no brief turn and no reset.
      await waitUntil(
        () =>
          stateOf(h, info.id) === "waiting_for_response" ||
          texts(old).some(isBriefPrompt),
        "at rest after the crossing turn",
      );
      await settle();
      expect(texts(old).some(isBriefPrompt)).toBe(false);
      expect(h.fake.sessions).toHaveLength(1);
      // The enabling condition: the crossing sample is committed.
      expect(h.mgr.getAgent(info.id)?.contextUsage?.totalTokens).toBe(190_000);
      expect(systemLines(h)).not.toContain(
        en.t("systemEntries.autoHandoff.writingPercent", { percent: 85 }),
      );

      kind.send(h, info.id);
      const fresh = await freshSession(h, info.id, old);
      expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
      expect(sent(old, kind.marker)).toBe(false);
      expectInOrder(fresh.sent[0].text, [BRIEF, kind.marker]);
    });
  }

  it("a manual handoff on an armed agent at rest runs with the caller's brief, and no brief turn", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await atRestMeasured(h, info.id);
    expect(await h.mgr.handoff(info.id, "MANUAL-BRIEF")).toMatchObject({
      ok: true,
    });
    const fresh = await freshSession(h, info.id, old);
    expect(fresh.sent[0].text).toContain("MANUAL-BRIEF");
    expect(fresh.sent[0].text).not.toContain(AUTO_HANDOFF_FRESH_NOTICE);
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expect(
      systemLines(h).some((l) => l.startsWith("Handed off automatically")),
    ).toBe(false);
  });

  it("Ctrl+Enter on an armed agent at rest does not abort the brief turn it starts", async () => {
    const h = makeHarness();
    // The brief turn parks, so an abort of it would show.
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await atRestMeasured(h, info.id);
    void h.mgr.sendMessage(
      info.id,
      "NOW-NEXT",
      undefined,
      undefined,
      undefined,
      {
        sendNow: true,
      },
    );
    await waitUntil(() => briefSession !== null, "brief turn sent");
    await settle();
    expect(stateOf(h, info.id)).toBe("thinking");
    expect(systemLines(h)).not.toContain(
      en.t("systemEntries.autoHandoff.failed"),
    );
    briefSession!.completeTurn({ text: BRIEF });
    const fresh = await freshSession(h, info.id, old);
    expectInOrder(fresh.sent[0].text, [BRIEF, "NOW-NEXT"]);
    expect(sent(old, "NOW-NEXT")).toBe(false);
  });

  it("an armed agent released while idle runs the brief turn in its resumed session when a message wakes it", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await atRestMeasured(h, info.id);
    expect(await h.mgr.sweepIdleAgents(0)).toBe(1);
    expect(h.mgr.getAgent(info.id)?.dormant).toBe(true);

    void h.mgr.sendMessage(info.id, "WAKE-NEXT");
    await waitUntil(
      () => h.fake.sessions.length >= 3 && h.fake.sessions[2].sent.length > 0,
      "fresh session after the resumed one",
    );
    const [, resumed, fresh] = h.fake.sessions;
    expect(resumed.isResume).toBe(true);
    expect(texts(resumed).filter(isBriefPrompt)).toHaveLength(1);
    expect(sent(resumed, "WAKE-NEXT")).toBe(false);
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expectInOrder(fresh.sent[0].text, [BRIEF, "WAKE-NEXT"]);
  });
});

describe("automatic handoff: an edit", () => {
  it("forks with no brief turn, and the fork does not stay armed", async () => {
    const h = makeHarness({ editable: true });
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await atRestMeasured(h, info.id);
    const entry = h.mgr
      .getAgentLogs(info.id)
      .find((e) => e.kind === "user_message" && e.content === "work")!;
    void h.mgr.editMessage(info.id, entry.id, "work, edited");
    await waitUntil(() => {
      const cur = h.fake.sessionForAgent(info.id);
      return !!cur && cur !== old && sent(cur, "work, edited");
    }, "edited turn runs in the fork");
    const fork = h.fake.sessionForAgent(info.id)!;
    expect(fork.sessionId).toBe("forked-1");
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expect(texts(fork).some(isBriefPrompt)).toBe(false);
    // The fork's first turn ends below the trigger; the next message runs in
    // the fork, with no brief turn.
    h.measure.now = ctx(20_000, 200_000);
    fork.completeTurn({ text: "edited done" });
    await nextMessage(h, info.id);
    await waitUntil(() => sent(fork, NEXT), "next message in the fork");
    expect(texts(fork).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessionForAgent(info.id)).toBe(fork);
  });
});

describe("automatic handoff: the queue", () => {
  it("messages queued during the crossing turn and the brief turn go to the fresh session after the brief", async () => {
    const h = makeHarness();
    // The brief turn parks until the test answers it.
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    expect(
      h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "QUEUED-ONE" }),
    ).toMatchObject({ ok: true, queued: true });
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    await waitUntil(() => briefSession !== null, "brief turn sent");

    // During the brief turn: a steer is declined, a manual handoff refused,
    // and a member's message waits.
    expect(
      h.mgr.enqueueMessage(
        info.id,
        { sender: SENDER, text: "QUEUED-TWO" },
        { steer: true },
      ),
    ).toMatchObject({
      ok: true,
      queued: true,
      steered: false,
      steerDeclined: "auto_handoff",
    });
    expect(await h.mgr.handoff(info.id, "manual brief")).toMatchObject({
      ok: false,
      status: 409,
      error: "handoff_in_progress",
    });
    void h.mgr.sendMessage(info.id, "MEMBER-THREE");
    await settle();
    // Only the brief prompt reached the old session after the crossing turn.
    expect(texts(old).slice(1)).toHaveLength(1);
    expect(isBriefPrompt(texts(old)[1])).toBe(true);

    briefSession!.completeTurn({ text: BRIEF });
    const fresh = await freshSession(h, info.id, old);
    expectInOrder(fresh.sent[0].text, [
      BRIEF,
      "QUEUED-ONE",
      "QUEUED-TWO",
      "MEMBER-THREE",
    ]);
    expect(texts(old).join("\n")).not.toContain("QUEUED");
    expect(texts(old).join("\n")).not.toContain("MEMBER-THREE");
    // While the phase held the queue, the flush that met it returned without
    // calling itself again: a handful of gate hits, not a spin until the reset.
    expect(h.mgr._testAutoHandoffGateHits(info.id)).toBeLessThan(10);
  });

  it("a steer queued before arming is not delivered into the brief turn at its tool boundary", async () => {
    const h = makeHarness({ toolBoundaryDelivery: true });
    let boundary: string | null | undefined;
    h.brief.answer = (s) => {
      boundary = s.toolBoundary();
      s.completeTurn({ text: BRIEF });
    };
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    // Queued as a boundary steer during the crossing turn, which reaches no
    // tool boundary before it ends.
    expect(
      h.mgr.enqueueMessage(
        info.id,
        { sender: SENDER, text: "STEERED" },
        { steer: true },
      ),
    ).toMatchObject({ ok: true, steered: true });
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    const fresh = await freshSession(h, info.id, old);
    expect(boundary).toBeNull();
    expectInOrder(fresh.sent[0].text, [BRIEF, "STEERED"]);
  });

  it("a member's message and skill between the brief turn and the reset wait for the fresh session", async () => {
    // Hold the window open: handoff's usage-cap read for the agent's member
    // manager parks until the test releases it.
    const claudeHome = join(STATE_ROOT, "claude-home");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
    const skillDir = join(STATE_ROOT, "skills", "autohandoffskill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "SKILL-BODY: do the thing.");
    const memberId = userIdFor("Cap Member", "member");
    const gate: { hold: boolean; release: (() => void) | null } = {
      hold: false,
      release: null,
    };
    setMemberUsageCapForTests(
      createMemberUsageCap({
        reader: {
          async read() {
            // One-shot: only the first read after the brief turn parks.
            if (gate.hold) {
              gate.hold = false;
              await new Promise<void>((res) => {
                gate.release = res;
              });
            }
            return {
              kind: "weekly",
              usedPercent: 1,
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
    const h = makeHarness();
    h.brief.answer = (s) => {
      gate.hold = true;
      s.completeTurn({ text: BRIEF });
    };
    const info = (await h.mgr.spawn(
      "Receiver",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
      undefined,
      undefined,
      undefined,
      "Cap Member",
      "claude",
      undefined,
      memberId,
    ))!;
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await waitUntil(() => gate.release !== null, "handoff waits on the cap");
    expect(stateOf(h, info.id)).not.toBe("thinking");

    void h.mgr.sendMessage(info.id, "MEMBER-IN-WINDOW");
    void h.mgr.sendMessage(info.id, "/autohandoffskill");
    await settle();
    expect(texts(old).some((t) => t.includes("MEMBER-IN-WINDOW"))).toBe(false);
    expect(texts(old).some((t) => t.includes("SKILL-BODY"))).toBe(false);

    gate.release!();
    const fresh = await freshSession(h, info.id, old);
    expectInOrder(fresh.sent[0].text, [
      BRIEF,
      NEXT,
      "MEMBER-IN-WINDOW",
      "SKILL-BODY",
    ]);
  });

  it("writes an audit row with its own actor kind and the agent as target", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await freshSession(h, info.id, old);
    await waitUntil(
      () =>
        officeAuditStore().list({ actorKind: "auto_handoff" }).items.length > 0,
      "audit row",
    );
    const row = officeAuditStore().list({ actorKind: "auto_handoff" }).items[0];
    expect(row.operation).toBe("agents.handoff");
    expect(row.targets).toEqual([info.id]);
  });
});

describe("automatic handoff: a sample that lands late", () => {
  // The sample lands after a send stops waiting for it.
  const LATE = { waitMs: 50, delayMs: 150 };
  const committed = (h: Harness, id: string, tokens: number) =>
    h.mgr.getAgent(id)?.contextUsage?.totalTokens === tokens;

  it("arms behind the batch that went to the old session; switching off before the brief turn drops it", async () => {
    const h = makeHarness({ sampleWaitMs: LATE.waitMs });
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "QUEUED-ONE" });
    // Past flushQueue's bounded wait: the batch goes to the old session.
    h.measure.delayMs = LATE.delayMs;
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    await waitUntil(
      () => texts(old).some((t) => t.includes("QUEUED-ONE")),
      "batch sent to the old session",
    );
    // The enabling condition: the batch went before the sample landed.
    expect(committed(h, info.id, 190_000)).toBe(false);
    await waitUntil(() => committed(h, info.id, 190_000), "late sample");
    // Armed during the batch turn; the brief turn waits for it to end.
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    await h.mgr.editAgent(info.id, { autoHandoff: false });
    h.measure.delayMs = 0;
    h.measure.now = ctx(20_000, 200_000);
    old.completeTurn({ text: "batch done" });
    // The next message, which an armed agent would hand off with, runs in
    // place.
    await nextMessage(h, info.id);
    await waitUntil(() => sent(old, NEXT), "message runs in the old session");
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);
  });

  it("with the switch left on, the brief turn starts at the next message after the batch turn", async () => {
    const h = makeHarness({ sampleWaitMs: LATE.waitMs });
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "QUEUED-ONE" });
    h.measure.delayMs = LATE.delayMs;
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    await waitUntil(
      () => texts(old).some((t) => t.includes("QUEUED-ONE")),
      "batch sent to the old session",
    );
    // The enabling condition: the batch went before the sample landed.
    expect(committed(h, info.id, 190_000)).toBe(false);
    await waitUntil(() => committed(h, info.id, 190_000), "late sample");
    h.measure.delayMs = 0;
    old.completeTurn({ text: "batch done" });
    await nextMessage(h, info.id);
    const fresh = await freshSession(h, info.id, old);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
    expect(sent(fresh, NEXT)).toBe(true);
    expect(sent(old, NEXT)).toBe(false);
  });
});

describe("automatic handoff: failures", () => {
  const failed = en.t("systemEntries.autoHandoff.failed");

  async function expectFailed(h: Harness, id: string) {
    await waitUntil(() => systemLines(h).includes(failed), "failure line");
    expect(h.fake.sessions.filter((s) => s.opts.agentId === id)).toHaveLength(
      1,
    );
    // The attempt is used: the member's wrap-up notice comes back now.
    expect(contextNoticeAt(h, 95)).toBe(true);
  }

  // The conversation continues in the old session: the message that started
  // the attempt goes there, with the wrap-up advice.
  async function expectOldSessionContinues(old: FakeSession) {
    await waitUntil(() => sent(old, NEXT), "old session continues");
    expect(texts(old).at(-1)).toContain("--- begin isomux: context-check ---");
  }

  it("a brief turn that fails", async () => {
    const h = makeHarness();
    h.brief.answer = (s) => s.completeTurn({ status: "failed", error: "boom" });
    const info = await spawn(h);
    await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await expectFailed(h, info.id);
    // A failed turn leaves the agent in error, as any failed turn does, and
    // the message that started the attempt stays queued.
    expect(stateOf(h, info.id)).toBe("error");
    expect(
      h.mgr
        .getAllAgents()
        .find((a) => a.id === info.id)
        ?.queue?.map((m) => m.text),
    ).toEqual([NEXT]);
  });

  it("a brief turn with no text", async () => {
    const h = makeHarness();
    h.brief.answer = (s) => s.completeTurn({ text: "   " });
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await expectFailed(h, info.id);
    await expectOldSessionContinues(old);
  });

  it("a brief turn the member stops", async () => {
    const h = makeHarness();
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await waitUntil(() => briefSession !== null, "brief turn sent");
    await h.mgr.abort(info.id);
    await waitUntil(() => systemLines(h).includes(failed), "failure line");
    // The message that started the attempt goes to the old conversation; the
    // attempt is used.
    await waitUntil(
      () => sent(h.fake.sessionForAgent(info.id), NEXT),
      "conversation continues",
    );
    expect(texts(h.fake.sessionForAgent(info.id)).join("\n")).not.toContain(
      BRIEF,
    );
    expect(old.sent.some((m) => isBriefPrompt(m.text))).toBe(true);
  });

  it("a handoff whose brief cannot be written leaves the attempt open", async () => {
    const h = makeHarness();
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await waitUntil(() => briefSession !== null, "brief turn sent");
    // A queued message first, so the queue store is loaded before the write
    // that fails.
    expect(
      h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "QUEUED-ONE" }),
    ).toMatchObject({ ok: true, queued: true });
    const storePath = join(STATE_ROOT, "message-queues.json");
    blockAtomicFileReplacement(storePath);
    try {
      briefSession!.completeTurn({ text: BRIEF });
      await waitUntil(
        () => keyCount(h, RETRY_KEY) > 0 || systemLines(h).includes(failed),
        "the attempt ended",
      );
    } finally {
      rmSync(storePath, { recursive: true, force: true });
    }
    expect(h.fake.sessions).toHaveLength(1);
    expect(old.closed).toBe(false);
    await expectAttemptOpen(h, old, 1);
    // The queue goes to the old session after all, and the next completed
    // turn above the trigger tries again.
    h.brief.answer = (s) => s.completeTurn({ text: BRIEF });
    await expectRetried(h, info.id, old, "QUEUED-ONE");
  });

  // Part of a brief, then the usage limit, as the Claude engine reports it.
  function limitStop(s: FakeSession, resetsAtMs: number) {
    s.push({ kind: "assistant_text", text: "BRIEF-PART" });
    s.push({ kind: "system_text", text: "You've hit your limit" });
    s.push({ kind: "usage_limit_stop", resetsAtMs });
    s.completeTurn();
  }
  const inAnHour = () => Date.now() + 60 * 60 * 1000;

  it("a brief turn a usage limit stops is not handed off, and the attempt stays open until a completed turn", async () => {
    const h = makeHarness();
    // Every brief turn stops so until the limit lifts below: a retry on the
    // brief turn's own end would loop while the limit holds.
    h.brief.answer = (s) => limitStop(s, inAnHour());
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await expectAttemptOpen(h, old, 1);
    h.brief.answer = (s) => s.completeTurn({ text: BRIEF });
    const fresh = await expectRetried(h, info.id, old, NEXT);
    expect(texts(fresh).join("\n")).not.toContain("BRIEF-PART");
  });

  it("a brief turn a usage limit stops arms no resume after the limit", async () => {
    // The resume timers never fire: the test reads the armed resume.
    const clock: LimitResumeClock = {
      now: () => Date.now(),
      setTimeout: () => ({}),
      clearTimeout: () => {},
    };
    const h = makeHarness({ limitResumeClock: clock });
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    // The enabling condition: the switch armLimitResume reads is on.
    expect(limitResumeOn(h.mgr.getAgent(info.id)!)).toBe(true);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await atRestMeasured(h, info.id);
    const queued = h.mgr.enqueueMessage(info.id, {
      sender: SENDER,
      text: NEXT,
    });
    if (!queued.ok) throw new Error(queued.error);
    await waitUntil(() => briefSession !== null, "brief turn sent");
    // With the message that started the attempt gone, no turn follows the
    // brief turn to drop a resume it armed.
    expect(h.mgr.cancelQueued(info.id, queued.messageId!)).toBe(true);
    limitStop(briefSession!, inAnHour());
    await expectAttemptOpen(h, old, 1);
    expect(
      loadAgents()
        .flatMap((r) => r.agents)
        .find((a) => a.id === info.id)?.limitResumeAt,
    ).toBeUndefined();
  });

  it("a /clear during the brief turn ends the attempt with no failure line", async () => {
    const h = makeHarness();
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await waitUntil(() => briefSession !== null, "brief turn sent");
    await h.mgr.newConversation(info.id);
    await settle();
    expect(systemLines(h)).not.toContain(failed);
    expect(
      systemLines(h).some((l) => l.startsWith("Handed off automatically")),
    ).toBe(false);
    // The /clear carries the message to the fresh conversation, which runs
    // it with no brief.
    const fresh = await freshSession(h, info.id, old);
    expect(sent(fresh, NEXT)).toBe(true);
    expect(texts(fresh).join("\n")).not.toContain(BRIEF);
    expect(
      officeAuditStore().list({ actorKind: "auto_handoff" }).items,
    ).toHaveLength(0);
  });
});

describe("automatic handoff: the member usage cap", () => {
  // The brief turn has no member: the rule for input no human sent
  // (usage-caps-design.md section 3b) decides, by the agent's manager.
  it("an owner's agent at the cap: the brief turn runs and the handoff completes", async () => {
    const cap = capOn();
    const h = makeHarness();
    const info = await spawn(h, {
      manager: { name: "Cap Owner", role: "owner" },
    });
    const old = await startTurn(h, info.id);
    cap.used = 90;
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    await atRestMeasured(h, info.id);
    // Another agent's message, which the cap does not cover for this agent.
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "AGENT-NEXT" });
    const fresh = await freshSession(h, info.id, old);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
    expectInOrder(fresh.sent[0].text, [BRIEF, "AGENT-NEXT"]);
    expect(keyCount(h, RETRY_KEY)).toBe(0);
    expect(systemLines(h)).not.toContain(
      en.t("systemEntries.autoHandoff.failed"),
    );
    // The enabling condition: the cap refuses on this agent's account. A
    // member's own message is refused.
    h.measure.now = ctx(20_000, 200_000);
    fresh.completeTurn({ text: "resumed" });
    await atRestMeasured(h, info.id);
    expect(keyCount(h, CAP_KEY)).toBe(0);
    userIdFor("Cap Member", "member");
    void h.mgr.sendMessage(info.id, "MEMBER-AT-CAP", "Cap Member");
    await waitUntil(() => keyCount(h, CAP_KEY) > 0, "member refused");
    expect(sent(fresh, "MEMBER-AT-CAP")).toBe(false);
  });

  it("a member's agent at the cap: the brief turn is refused, the attempt stays open, and it hands off after the cap lifts", async () => {
    const cap = capOn();
    const h = makeHarness();
    const info = await spawn(h, {
      manager: { name: "Cap Member", role: "member" },
    });
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await atRestMeasured(h, info.id);
    cap.used = 90;
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "AGENT-NEXT" });
    await expectAttemptOpen(h, old, 0);
    // Refused before send: no brief prompt, no reset. The agent's message
    // is refused too (the enabling condition: the cap covers this agent).
    await waitUntil(() => keyCount(h, CAP_KEY) >= 2, "both refusals");
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expect(sent(old, "AGENT-NEXT")).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);

    // The cap lifts. A completed turn above the trigger re-arms; the next
    // message hands off.
    cap.used = 1;
    memberUsageCap().invalidate("claude");
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    const again = await startTurn(h, info.id, "WORK-AGAIN");
    expect(again === old).toBe(true);
    h.measure.now = ctx(192_000, 200_000);
    old.completeTurn({ text: "done" });
    await atRestMeasured(h, info.id);
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "AGENT-AFTER" });
    const fresh = await freshSession(h, info.id, old);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
    expectInOrder(fresh.sent[0].text, [BRIEF, "AGENT-AFTER"]);
  });

  it("a member's agent whose cap closes during the handoff: the fresh session still gets the brief", async () => {
    const cap = capOn();
    const h = makeHarness();
    // The brief turn and the handoff's own reading are under the line; the
    // fresh session's flush reads over it.
    h.brief.answer = (s) => {
      cap.flipAfterNextRead = true;
      s.completeTurn({ text: BRIEF });
    };
    const info = await spawn(h, {
      manager: { name: "Cap Member", role: "member" },
    });
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await atRestMeasured(h, info.id);
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "AGENT-NEXT" });
    // The enabling condition: the fresh flush refused (the agent's message).
    await waitUntil(() => keyCount(h, CAP_KEY) > 0, "flush refusal");
    await settle();
    const fresh = h.fake.sessions.filter((s) => s !== old);
    expect(fresh).toHaveLength(1);
    expect(sent(fresh[0], BRIEF)).toBe(true);
    expect(h.fake.sessions.some((s) => sent(s, "AGENT-NEXT"))).toBe(false);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
  });
});

describe("automatic handoff: loop guard", () => {
  it("a conversation the handoff opened above the trigger pauses the mode, once", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    // The fresh session's first turn (the brief) ends still above it.
    const fresh = await freshSession(h, info.id, old);
    h.measure.now = ctx(185_000, 200_000);
    fresh.completeTurn({ text: "resumed" });
    const paused = en.t("systemEntries.autoHandoff.paused");
    await waitUntil(() => systemLines(h).includes(paused), "pause line");
    // Paused: the wrap-up notice comes back on the same sample.
    expect(contextNoticeAt(h, 93)).toBe(true);
    // Further turns above the trigger hand off no more.
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await turnEndingAt(h, info.id, ctx(195_000, 200_000));
    await nextMessage(h, info.id, "AFTER-PAUSE");
    await waitUntil(() => sent(fresh, "AFTER-PAUSE"), "message runs in place");
    expect(texts(fresh).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessions).toHaveLength(2);
    expect(systemLines(h).filter((l) => l === paused)).toHaveLength(1);
  });

  it("a conversation the handoff opened below the trigger can hand off again", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    const fresh = await freshSession(h, info.id, old);
    h.measure.now = ctx(20_000, 200_000);
    fresh.completeTurn({ text: "resumed" });
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await nextMessage(h, info.id);
    await freshSession(h, info.id, fresh);
    expect(h.fake.sessions).toHaveLength(3);
  });
});

describe("automatic handoff: wrap-up notices", () => {
  it("stay quiet for both audiences while an attempt is still possible", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    // 80% is past the 75 band and below the 85% trigger.
    await turnEndingAt(h, info.id, ctx(160_000, 200_000));
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await settle();
    const s = await startTurn(h, info.id, "next");
    expect(texts(s).at(-1)).not.toContain("context-check");
    expect(contextNoticeAt(h, 80)).toBe(false);
  });
});

describe("automatic handoff: the settings survive a restart", () => {
  it("restores the switch off and the agent's own token value; an agent persisted without the switch is on", async () => {
    const fake = new FakeBackend();
    activeFakes.push(fake);
    const persisted = (
      id: string,
      desk: number,
      extra: { autoHandoff?: boolean; autoHandoffTokens?: number },
    ) => ({
      id,
      name: id,
      desk,
      cwd: STATE_ROOT,
      outfit: {
        hat: "none" as const,
        color: "#ffffff",
        hair: "#000000",
        hairStyle: "short" as const,
        skin: "#ffffff",
        beard: "none" as const,
        accessory: null,
      },
      permissionMode: "default" as const,
      modelFamily: "opus",
      agentType: "claude" as const,
      lastSessionId: null,
      topic: null,
      customInstructions: null,
      userId: null,
      username: null,
      ...extra,
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms }),
      initialRooms: [
        {
          id: "room-a",
          name: "room-a",
          prompt: null,
          agents: [
            persisted("custom", 0, {
              autoHandoff: false,
              autoHandoffTokens: 300_000,
            }),
            persisted("legacy", 1, {}),
          ],
        },
      ],
    });
    mgr.configureAgentTurnDeps();
    await mgr.restoreAgents();
    expect(mgr.getAgent("custom")?.autoHandoff).toBe(false);
    expect(mgr.getAgent("custom")?.autoHandoffTokens).toBe(300_000);
    // Absent and true both read as on; only an explicit false is off.
    expect(mgr.getAgent("legacy")?.autoHandoff).not.toBe(false);
  });
});

describe("automatic handoff: whose turn the brief turn is", () => {
  it("no member's, even when a member's message starts it (task 10d7ead6)", async () => {
    const morgan = userIdFor("Handoff Morgan", "member");
    const h = makeHarness();
    const info = await spawn(h);
    // The crossing turn is Morgan's, so a brief turn that keeps the last
    // turn's members, or takes the waiting message's, fails.
    void h.mgr.sendMessage(info.id, "work", "Handoff Morgan");
    await waitUntil(
      () =>
        stateOf(h, info.id) === "thinking" &&
        sent(h.fake.sessionForAgent(info.id), "] work"),
      "Morgan's crossing turn running",
    );
    const old = h.fake.sessionForAgent(info.id)!;
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    await atRestMeasured(h, info.id);
    expect(h.mgr.getAgent(info.id)?.turnMemberIds).toEqual([morgan]);

    let during: string[] | undefined;
    h.brief.answer = (s) => {
      during = [...(h.mgr.getAgent(info.id)?.turnMemberIds ?? [])];
      s.completeTurn({ text: BRIEF });
    };
    void h.mgr.sendMessage(info.id, NEXT, "Handoff Morgan");
    await freshSession(h, info.id, old);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
    expect(during).toEqual([]);
  });
});
