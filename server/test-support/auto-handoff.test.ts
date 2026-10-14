// Automatic handoff (internal-docs/auto-handoff-design.md). Seam: the DI
// manager (createAgentManager + FakeBackend). A member's message starts each
// turn and parks it until the test completes it; getContextUsage reports the
// value the test sets, so the test decides what the crossing turn measured.
// The brief turn is answered by the fake session as soon as it is sent.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { blockAtomicFileReplacement, removeStateDir } from "./temp-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { translatorForLanguage } from "../i18n.ts";
import { createMember } from "../users.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import {
  AUTO_HANDOFF_FRESH_NOTICE,
  autoHandoffTrigger,
} from "../auto-handoff.ts";
import { officeAuditStore } from "../audit-store.ts";
import {
  createMemberUsageCap,
  setMemberUsageCapForTests,
} from "../member-usage-cap.ts";
import { WEEK_MS } from "../office-usage.ts";
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
  opts: { abortInPlace?: boolean; toolBoundaryDelivery?: boolean } = {},
): Harness {
  const measure: Harness["measure"] = { now: null };
  const brief: Harness["brief"] = {
    answer: (s) => s.completeTurn({ text: BRIEF }),
  };
  const fake = new FakeBackend({
    ...(opts.toolBoundaryDelivery ? { toolBoundaryDelivery: true } : {}),
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
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(fake);
  return { mgr, fake, logs, measure, brief };
}

async function spawn(
  h: Harness,
  opts: { autoHandoff?: boolean; agentType?: AgentInfo["agentType"] } = {},
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
    opts.agentType ?? "claude",
  );
  if (!info) throw new Error("spawn returned null");
  if (opts.autoHandoff ?? true)
    await h.mgr.editAgent(info.id, { autoHandoff: true });
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

function expectInOrder(text: string, needles: string[]) {
  const at = needles.map((n) => text.indexOf(n));
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
}

describe("automatic handoff: arming", () => {
  for (const agentType of ["claude", "codex", "opencode"] as const) {
    it(`${agentType}: 90% of a small window hands off, with the brief captured after the last tool call`, async () => {
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
      const old = await turnEndingAt(h, info.id, ctx(182_000, 200_000));

      const fresh = await freshSession(h, info.id, old);
      // The brief turn ran in the old session, with nothing else.
      expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
      expect(texts(old).at(-1)).toContain("182,000 tokens (91% full)");
      // The fresh session got the notice, then the brief from the old one.
      const first = fresh.sent[0].text;
      expectInOrder(first, [
        "--- begin isomux: auto-handoff ---",
        AUTO_HANDOFF_FRESH_NOTICE,
        "[Handoff from your previous session]",
        captured,
      ]);
      expect(first).not.toContain("Checking first.");
      // Both lines name the 90% limit, not the 91% measured.
      expect(systemLines(h)).toContain(
        en.t("systemEntries.autoHandoff.writingPercent", { percent: 90 }),
      );
      expect(systemLines(h)).toContain(
        en.t("systemEntries.autoHandoff.donePercent", { percent: 90 }),
      );
      // The brief turn's own sample, still above the trigger, does not start
      // a second attempt in either session.
      await settle();
      expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
      expect(h.fake.sessions).toHaveLength(2);
      expect(texts(fresh).some(isBriefPrompt)).toBe(false);
      // The fresh chat starts with that line, not "New conversation started."
      expect(systemLines(h)).not.toContain(
        en.t("systemEntries.newConversation"),
      );
    });
  }

  it("500k tokens of a 1M window hands off before 90%, with no 50% notice to either audience", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(510_000, 1_000_000));
    await freshSession(h, info.id, old);
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.writingTokens", { thousands: 500 }),
    );
    expect(systemLines(h)).toContain(
      en.t("systemEntries.autoHandoff.doneTokens", { thousands: 500 }),
    );
    // The arming sample is past the 50 band: neither the member line nor the
    // agent's context check.
    expect(
      systemLines(h).some((l) => l.startsWith("Context is 51% full.")),
    ).toBe(false);
    expect(texts(old).join("\n")).not.toContain("context-check");
  });

  for (const [agentType, via] of [
    ["claude", "sdk"],
    ["opencode", "adapter"],
  ] as const) {
    it(`${agentType}: an engine that compacts before 90% hands off 5 points ahead of its compaction point`, async () => {
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
      await freshSession(h, info.id, old);
      expect(systemLines(h)).toContain(
        en.t("systemEntries.autoHandoff.writingCompaction", { percent: 75 }),
      );
      expect(systemLines(h)).toContain(
        en.t("systemEntries.autoHandoff.doneCompaction", { percent: 75 }),
      );
    });
  }

  it("with the switch off, nothing changes: no brief turn, no reset, and the wrap-up notice shows", async () => {
    const h = makeHarness();
    const info = await spawn(h, { autoHandoff: false });
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await waitUntil(
      () => systemLines(h).some((l) => l.startsWith("Context is 95% full.")),
      "member wrap-up notice",
    );
    await settle();
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
    h.measure.now = ctx(170_000, 200_000);
    s.completeTurn({ text: "done" });
    await waitUntil(() => committed(170_000), "turn-end sample committed");
    await settle();
    expect(texts(s).some(isBriefPrompt)).toBe(false);

    // A turn-end sample equal to the last mid-turn one still commits and arms.
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await startTurn(h, info.id);
    h.measure.now = ctx(190_000, 200_000);
    usageUpdate(s);
    await waitUntil(() => committed(190_000), "second mid-turn sample");
    s.completeTurn({ text: "done" });
    await freshSession(h, info.id, s);
    expect(texts(s).filter(isBriefPrompt)).toHaveLength(1);
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
    const member = createMember("Cap Member", { role: "member" });
    if (!member.ok) throw new Error("member not created");
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
      member.user.id,
    ))!;
    await h.mgr.editAgent(info.id, { autoHandoff: true });
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
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
      "MEMBER-IN-WINDOW",
      "SKILL-BODY",
    ]);
  });

  it("the brief is the text after the brief turn's last tool call", async () => {
    const h = makeHarness();
    h.brief.answer = (s) => {
      s.push({ kind: "assistant_text", text: "Checking git status first." });
      s.push({
        kind: "tool_call",
        toolUseId: "t1",
        name: "Bash",
        input: { command: "git status" },
      });
      s.push({ kind: "tool_result", toolUseId: "t1", content: "clean" });
      s.completeTurn({ text: BRIEF });
    };
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    const fresh = await freshSession(h, info.id, old);
    expect(fresh.sent[0].text).toContain(BRIEF);
    expect(fresh.sent[0].text).not.toContain("Checking git status");
  });

  it("writes an audit row with its own actor kind and the agent as target", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
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
  it("arms behind the batch that went to the old session; switching off before the brief turn drops it", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "QUEUED-ONE" });
    // Past flushQueue's bounded wait: the batch goes to the old session.
    h.measure.delayMs = 700;
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    await waitUntil(
      () => texts(old).some((t) => t.includes("QUEUED-ONE")),
      "batch sent to the old session",
    );
    await sleep(800);
    // Armed during the batch turn; the brief turn waits for it to end.
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    await h.mgr.editAgent(info.id, { autoHandoff: false });
    h.measure.delayMs = 0;
    h.measure.now = ctx(20_000, 200_000);
    old.completeTurn({ text: "batch done" });
    await settle();
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);
  });

  it("with the switch left on, the brief turn starts when the batch turn ends", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "QUEUED-ONE" });
    h.measure.delayMs = 700;
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    await waitUntil(
      () => texts(old).some((t) => t.includes("QUEUED-ONE")),
      "batch sent to the old session",
    );
    await sleep(800);
    h.measure.delayMs = 0;
    old.completeTurn({ text: "batch done" });
    await freshSession(h, info.id, old);
    expect(texts(old).filter(isBriefPrompt)).toHaveLength(1);
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
    expect(
      systemLines(h).some((l) => l.startsWith("Context is 95% full.")),
    ).toBe(true);
  }

  // The conversation continues in the old session, and the agent hears the
  // wrap-up advice on the next message.
  async function expectOldSessionContinues(
    h: Harness,
    id: string,
    old: FakeSession,
  ) {
    await waitUntil(
      () => stateOf(h, id) === "waiting_for_response",
      "at rest after the failure",
    );
    void h.mgr.sendMessage(id, "AFTER");
    await waitUntil(() => got(old, "AFTER"), "old session continues");
    expect(texts(old).at(-1)).toContain("--- begin isomux: context-check ---");
  }

  it("a brief turn that fails", async () => {
    const h = makeHarness();
    h.brief.answer = (s) => s.completeTurn({ status: "failed", error: "boom" });
    const info = await spawn(h);
    await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await expectFailed(h, info.id);
    // A failed turn leaves the agent in error, as any failed turn does.
    expect(stateOf(h, info.id)).toBe("error");
  });

  it("a brief turn with no text", async () => {
    const h = makeHarness();
    h.brief.answer = (s) => s.completeTurn({ text: "   " });
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await expectFailed(h, info.id);
    await expectOldSessionContinues(h, info.id, old);
  });

  it("a brief turn the member stops", async () => {
    const h = makeHarness();
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await waitUntil(() => briefSession !== null, "brief turn sent");
    await h.mgr.abort(info.id);
    await waitUntil(() => systemLines(h).includes(failed), "failure line");
    // The member's next message goes to the old session; the attempt is used.
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest after the stop",
    );
    void h.mgr.sendMessage(info.id, "AFTER");
    await waitUntil(
      () => got(h.fake.sessionForAgent(info.id), "AFTER"),
      "conversation continues",
    );
    expect(texts(h.fake.sessionForAgent(info.id)).join("\n")).not.toContain(
      BRIEF,
    );
    expect(old.sent.some((m) => isBriefPrompt(m.text))).toBe(true);
  });

  it("a brief turn the usage cap refuses", async () => {
    const claudeHome = join(STATE_ROOT, "claude-home");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
    const h = makeHarness();
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    // On before the brief turn asks it: over the line, so it refuses.
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
    h.measure.now = ctx(190_000, 200_000);
    old.completeTurn({ text: "done" });
    await waitUntil(() => systemLines(h).includes(failed), "failure line");
    expect(texts(old).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);
  });

  it("a handoff whose brief cannot be written", async () => {
    const h = makeHarness();
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
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
      await waitUntil(() => systemLines(h).includes(failed), "failure line");
    } finally {
      rmSync(storePath, { recursive: true, force: true });
    }
    expect(h.fake.sessions).toHaveLength(1);
    expect(old.closed).toBe(false);
    // The queue goes to the old session after all.
    await waitUntil(
      () => texts(old).some((t) => t.includes("QUEUED-ONE")),
      "queue flushed to the old session",
    );
  });

  it("a /clear during the brief turn ends the attempt with no failure line", async () => {
    const h = makeHarness();
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await waitUntil(() => briefSession !== null, "brief turn sent");
    await h.mgr.newConversation(info.id);
    await settle();
    expect(systemLines(h)).not.toContain(failed);
    expect(
      systemLines(h).some((l) => l.startsWith("Handed off automatically")),
    ).toBe(false);
    // The fresh conversation can arm again.
    void h.mgr.sendMessage(info.id, "next");
    await waitUntil(
      () => got(h.fake.sessionForAgent(info.id), "next"),
      "fresh conversation runs",
    );
    expect(
      officeAuditStore().list({ actorKind: "auto_handoff" }).items,
    ).toHaveLength(0);
  });
});

describe("automatic handoff: loop guard", () => {
  it("a conversation the handoff opened above the trigger pauses the mode, once", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    // The fresh session's first turn (the brief) ends still above it.
    const fresh = await freshSession(h, info.id, old);
    h.measure.now = ctx(185_000, 200_000);
    fresh.completeTurn({ text: "resumed" });
    const paused = en.t("systemEntries.autoHandoff.paused");
    await waitUntil(() => systemLines(h).includes(paused), "pause line");
    // Paused: the wrap-up notice comes back on the same sample.
    expect(
      systemLines(h).some((l) => l.startsWith("Context is 93% full.")),
    ).toBe(true);
    // Further turns above the trigger hand off no more.
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await turnEndingAt(h, info.id, ctx(195_000, 200_000));
    await settle();
    expect(texts(fresh).some(isBriefPrompt)).toBe(false);
    expect(h.fake.sessions).toHaveLength(2);
    expect(systemLines(h).filter((l) => l === paused)).toHaveLength(1);
  });

  it("a conversation the handoff opened below the trigger can hand off again", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    const fresh = await freshSession(h, info.id, old);
    h.measure.now = ctx(20_000, 200_000);
    fresh.completeTurn({ text: "resumed" });
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await turnEndingAt(h, info.id, ctx(190_000, 200_000));
    await freshSession(h, info.id, fresh);
    expect(h.fake.sessions).toHaveLength(3);
  });
});

describe("automatic handoff: wrap-up notices", () => {
  it("stay quiet for both audiences while an attempt is still possible", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    // 80% is past the 75 band and below the 90% trigger.
    await turnEndingAt(h, info.id, ctx(160_000, 200_000));
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await settle();
    const s = await startTurn(h, info.id, "next");
    expect(texts(s).at(-1)).not.toContain("context-check");
    expect(
      systemLines(h).some((l) => l.startsWith("Context is 80% full.")),
    ).toBe(false);
  });

  it("show as before with the switch off", async () => {
    const h = makeHarness();
    const info = await spawn(h, { autoHandoff: false });
    await turnEndingAt(h, info.id, ctx(160_000, 200_000));
    await waitUntil(
      () => systemLines(h).some((l) => l.startsWith("Context is 80% full.")),
      "member notice",
    );
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    const s = await startTurn(h, info.id, "next");
    expect(texts(s).at(-1)).toContain("--- begin isomux: context-check ---");
  });
});

describe("automatic handoff: the switch survives a restart", () => {
  it("restores an agent persisted with the switch on, and one without it as off", async () => {
    const fake = new FakeBackend();
    activeFakes.push(fake);
    const persisted = (id: string, autoHandoff?: boolean) => ({
      id,
      name: id,
      desk: id === "on" ? 0 : 1,
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
      ...(autoHandoff !== undefined ? { autoHandoff } : {}),
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms }),
      initialRooms: [
        {
          id: "room-a",
          name: "room-a",
          prompt: null,
          agents: [persisted("on", true), persisted("legacy")],
        },
      ],
    });
    mgr.configureAgentTurnDeps();
    await mgr.restoreAgents();
    expect(mgr.getAgent("on")?.autoHandoff).toBe(true);
    expect(mgr.getAgent("legacy")?.autoHandoff ?? false).toBe(false);
  });
});
