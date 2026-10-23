// A member's typed /handoff (task 970930a3). Seam: the DI manager
// (createAgentManager + FakeBackend), as in auto-handoff.test.ts. The command
// arms the automatic handoff's phase with a manual marker: one brief turn in
// the old session, then a fresh session that gets the brief first.
// A member's message starts each work turn and parks it until the test
// completes it; the fake session answers a brief prompt as the test says.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
  handoffBriefPrompt,
} from "../auto-handoff.ts";
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
const NOTE = "NOTE-TEXT keep the migration";
const OTHER_NOTE = "OTHER-NOTE-TEXT";

// The manual brief prompt, with or without a note, as the session got it
// (the member prefix goes in front). The stub throws: nothing matches then.
function prompt(note?: string): string | null {
  try {
    return handoffBriefPrompt(note);
  } catch {
    return null;
  }
}
function briefNote(text: string): string | undefined | null {
  for (const note of [NOTE, OTHER_NOTE]) {
    const p = prompt(note);
    if (p !== null && text.includes(p)) return note;
  }
  const bare = prompt();
  return bare !== null && text.includes(bare) ? undefined : null;
}
const isManualBrief = (text: string) => briefNote(text) !== null;
// The automatic brief prompt opens with this; the manual one does not.
const isAutoBrief = (text: string) =>
  text.includes("[automatic handoff: your context is at");

function ctx(totalTokens: number, maxTokens: number): ContextUsage {
  return {
    model: "fake-model",
    totalTokens,
    maxTokens,
    percentage: (totalTokens / maxTokens) * 100,
  };
}

interface Harness {
  mgr: ReturnType<typeof createAgentManager>;
  fake: FakeBackend;
  logs: LogEntry[];
  measure: { now: ContextUsage | null };
  // How the fake session answers a brief prompt (manual or automatic).
  brief: { answer: (s: FakeSession) => void };
}

function makeHarness(opts: { abortInPlace?: boolean } = {}): Harness {
  const measure: Harness["measure"] = { now: null };
  const brief: Harness["brief"] = {
    answer: (s) => s.completeTurn({ text: BRIEF }),
  };
  const fake = new FakeBackend({
    session: {
      abortInPlace: opts.abortInPlace ?? false,
      contextUsage: async () => measure.now,
      onSend: (text, _a, s) => {
        if (isManualBrief(text) || isAutoBrief(text))
          setTimeout(() => brief.answer(s), 0);
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
  // Off unless a test asks: the member's /handoff does not need the switch.
  if (opts.autoHandoff) await h.mgr.editAgent(info.id, { autoHandoff: true });
  return info;
}

const stateOf = (h: Harness, id: string) => h.mgr.getAgent(id)?.state;
const texts = (s: FakeSession | undefined) =>
  (s?.sent ?? []).map((m) => m.text);
const got = (s: FakeSession | undefined, text: string) =>
  texts(s).some((t) => t === text || t.endsWith(`\nUser message:\n${text}`));
const sent = (s: FakeSession | undefined, needle: string) =>
  texts(s).some((t) => t.includes(needle));
const systemLines = (h: Harness) =>
  h.logs.filter((e) => e.kind === "system").map((e) => e.content);
// The catalog keys of the system lines, for a family of lines.
const lineKeys = (h: Harness) =>
  h.logs
    .filter((e) => e.kind === "system")
    .flatMap((e) => e.message ?? [])
    .flatMap((p) => (typeof p === "object" && "key" in p ? [p.key] : []));
const queueOf = (h: Harness, id: string) =>
  h.mgr
    .getAllAgents()
    .find((a) => a.id === id)
    ?.queue?.map((m) => m.text);

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

// One finished member turn: the agent has a conversation to hand off.
async function finishedTurn(
  h: Harness,
  id: string,
  usage: ContextUsage | null = null,
): Promise<FakeSession> {
  const s = await startTurn(h, id);
  h.measure.now = usage;
  s.completeTurn({ text: "done" });
  await waitUntil(
    () =>
      stateOf(h, id) === "waiting_for_response" &&
      (usage === null ||
        h.mgr.getAgent(id)?.contextUsage?.totalTokens === usage.totalTokens),
    "at rest after the turn",
  );
  return s;
}

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

// Long enough for a brief turn and a reset that are NOT supposed to happen.
const settle = () => sleep(150);

function expectInOrder(text: string, needles: string[]) {
  const at = needles.map((n) => text.indexOf(n));
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
}

const handedOff = en.t("systemEntries.handedOff");
const failedLine = en.t("systemEntries.handoff.failed");

describe("/handoff on an idle agent", () => {
  for (const agentType of ["claude", "codex", "opencode"] as const) {
    it(`${agentType}: one brief turn, then the fresh session opens on the brief with the manual line`, async () => {
      const h = makeHarness();
      const info = await spawn(h, { agentType });
      const old = await finishedTurn(h, info.id);
      void h.mgr.sendMessage(info.id, "/handoff");
      const fresh = await freshSession(h, info.id, old);

      // One brief turn, in the old session, with no note.
      const briefs = texts(old).filter(isManualBrief);
      expect(briefs).toHaveLength(1);
      expect(briefNote(briefs[0])).toBeUndefined();
      // The fresh session starts on the brief, with no automatic notice.
      const first = fresh.sent[0].text;
      expectInOrder(first, ["[Handoff from your previous session]", BRIEF]);
      expect(first).not.toContain(AUTO_HANDOFF_FRESH_NOTICE);
      expect(texts(fresh).some(isManualBrief)).toBe(false);
      // The manual line, not the automatic one nor a new conversation's.
      expect(systemLines(h)).toContain(handedOff);
      expect(systemLines(h)).not.toContain(
        en.t("systemEntries.newConversation"),
      );
      expect(
        lineKeys(h).some((k) => k.startsWith("systemEntries.autoHandoff.")),
      ).toBe(false);
      // The echo pairs with the prompt the session got, for edit-fork.
      const echo = h.logs.find(
        (e) => e.kind === "user_message" && e.content === "/handoff",
      );
      expect(echo?.metadata?.sdkText).toBe(briefs[0]);
      // Nothing more: no second brief turn, no third session.
      await settle();
      expect(h.fake.sessions).toHaveLength(2);
    });
  }

  it("the text after the command reaches the brief prompt as the member's note", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await finishedTurn(h, info.id);
    void h.mgr.sendMessage(info.id, `/handoff ${NOTE}`);
    await freshSession(h, info.id, old);
    const briefs = texts(old).filter(isManualBrief);
    expect(briefs).toHaveLength(1);
    expect(briefNote(briefs[0])).toBe(NOTE);
  });

  it("a released agent resumes its conversation to write the brief", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await finishedTurn(h, info.id);
    expect(await h.mgr.sweepIdleAgents(0)).toBe(1);
    expect(h.mgr.getAgent(info.id)?.dormant).toBe(true);

    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(
      () => h.fake.sessions.length >= 3 && h.fake.sessions[2].sent.length > 0,
      "fresh session after the resumed one",
    );
    const [, resumed, fresh] = h.fake.sessions;
    expect(resumed.isResume).toBe(true);
    expect(texts(resumed).filter(isManualBrief)).toHaveLength(1);
    expect(texts(old).some(isManualBrief)).toBe(false);
    expect(fresh.sent[0].text).toContain(BRIEF);
  });

  it("an agent in error after a failed turn resumes its conversation to write the brief", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await finishedTurn(h, info.id);
    const s = await startTurn(h, info.id, "second");
    s.completeTurn({ status: "failed", error: "boom" });
    await waitUntil(() => stateOf(h, info.id) === "error", "agent in error");
    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(
      () => h.fake.sessions.some((x) => texts(x).some(isManualBrief)),
      "brief turn sent",
    );
    const briefSession = h.fake.sessions.find((x) =>
      texts(x).some(isManualBrief),
    )!;
    const fresh = await freshSession(h, info.id, briefSession);
    expect(fresh.sent[0].text).toContain(BRIEF);
    expect(systemLines(h)).toContain(handedOff);
  });

  it("replaces an armed automatic handoff that has no brief turn yet", async () => {
    const h = makeHarness();
    const info = await spawn(h, { autoHandoff: true });
    // Above the trigger: the automatic handoff arms and waits for a message.
    const old = await finishedTurn(h, info.id, ctx(190_000, 200_000));
    void h.mgr.sendMessage(info.id, "/handoff");
    const fresh = await freshSession(h, info.id, old);
    expect(texts(old).filter(isManualBrief)).toHaveLength(1);
    expect(texts(old).some(isAutoBrief)).toBe(false);
    expect(fresh.sent[0].text).toContain(BRIEF);
    expect(fresh.sent[0].text).not.toContain(AUTO_HANDOFF_FRESH_NOTICE);
    expect(systemLines(h)).toContain(handedOff);
  });
});

describe("/handoff on a busy agent", () => {
  it("waits for the turn, then the brief goes first and every waiting message follows it in the fresh session", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    // Queued before the command: also goes to the fresh session.
    void h.mgr.sendMessage(info.id, "BEFORE-MSG");
    await waitUntil(
      () => queueOf(h, info.id)?.includes("BEFORE-MSG") === true,
      "BEFORE-MSG queued",
    );

    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(
      () => systemLines(h).includes(en.t("commands.handoff.waiting")),
      "waiting line",
    );
    // The running turn is not touched.
    await settle();
    expect(stateOf(h, info.id)).toBe("thinking");
    expect(texts(old).some(isManualBrief)).toBe(false);

    // While it waits: a steer is declined for the handoff, and a member's
    // message waits too.
    expect(
      h.mgr.enqueueMessage(
        info.id,
        { sender: SENDER, text: "STEER-MSG" },
        { steer: true },
      ),
    ).toMatchObject({
      ok: true,
      queued: true,
      steered: false,
      steerDeclined: "handoff",
    });
    void h.mgr.sendMessage(info.id, "AFTER-MSG");
    await settle();

    old.completeTurn({ text: "done" });
    const fresh = await freshSession(h, info.id, old);
    expect(texts(old).filter(isManualBrief)).toHaveLength(1);
    expectInOrder(fresh.sent[0].text, [
      BRIEF,
      "BEFORE-MSG",
      "STEER-MSG",
      "AFTER-MSG",
    ]);
    for (const m of ["BEFORE-MSG", "STEER-MSG", "AFTER-MSG"])
      expect(sent(old, m)).toBe(false);
  });

  it("a second /handoff while one waits is refused, and the first keeps its note", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const old = await startTurn(h, info.id);
    void h.mgr.sendMessage(info.id, `/handoff ${NOTE}`);
    await waitUntil(
      () => systemLines(h).includes(en.t("commands.handoff.waiting")),
      "waiting line",
    );
    void h.mgr.sendMessage(info.id, `/handoff ${OTHER_NOTE}`);
    await waitUntil(
      () => systemLines(h).includes(en.t("commands.handoff.underWay")),
      "refusal line",
    );
    old.completeTurn({ text: "done" });
    await freshSession(h, info.id, old);
    const briefs = texts(old).filter(isManualBrief);
    expect(briefs).toHaveLength(1);
    expect(briefNote(briefs[0])).toBe(NOTE);
  });

  it("Stop cancels a waiting /handoff: no brief turn, and the conversation continues", async () => {
    // In place: the session stays, and the aborted turn's end reaches the
    // queue gate, which would start the brief if the phase stayed.
    const h = makeHarness({ abortInPlace: true });
    const info = await spawn(h);
    const s = await startTurn(h, info.id);
    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(
      () => systemLines(h).includes(en.t("commands.handoff.waiting")),
      "waiting line",
    );
    const aborted = h.mgr.abort(info.id);
    s.completeTurn({ status: "interrupted" });
    expect(await aborted).toMatchObject({ ok: true });
    await waitUntil(
      () => systemLines(h).includes(en.t("systemEntries.handoff.canceled")),
      "canceled line",
    );
    await settle();
    expect(texts(s).some(isManualBrief)).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);
    // The next message runs in place.
    void h.mgr.sendMessage(info.id, "NEXT-MSG");
    await waitUntil(() => got(s, "NEXT-MSG"), "next message in place");
    expect(h.fake.sessions).toHaveLength(1);
  });

  for (const edit of [
    {
      name: "switching the automatic handoff off",
      change: { autoHandoff: false },
    },
    { name: "a new token value", change: { autoHandoffTokens: 600_000 } },
  ] as const) {
    it(`${edit.name} does not drop a waiting /handoff`, async () => {
      const h = makeHarness();
      const info = await spawn(h, { autoHandoff: true });
      const old = await startTurn(h, info.id);
      void h.mgr.sendMessage(info.id, "/handoff");
      await waitUntil(
        () => systemLines(h).includes(en.t("commands.handoff.waiting")),
        "waiting line",
      );
      await h.mgr.editAgent(info.id, edit.change);
      old.completeTurn({ text: "done" });
      const fresh = await freshSession(h, info.id, old);
      expect(texts(old).filter(isManualBrief)).toHaveLength(1);
      expect(fresh.sent[0].text).toContain(BRIEF);
    });
  }
});

describe("/handoff refusals", () => {
  it("an empty conversation has nothing to hand off", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(
      () => systemLines(h).includes(en.t("commands.handoff.empty")),
      "empty line",
    );
    await settle();
    expect(h.fake.sessions.some((s) => texts(s).some(isManualBrief))).toBe(
      false,
    );
    expect(systemLines(h)).not.toContain(handedOff);
  });

  it("during the brief turn, a second /handoff is refused and the first completes", async () => {
    const h = makeHarness();
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await finishedTurn(h, info.id);
    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(() => briefSession !== null, "brief turn sent");
    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(
      () => systemLines(h).includes(en.t("commands.handoff.underWay")),
      "refusal line",
    );
    briefSession!.completeTurn({ text: BRIEF });
    const fresh = await freshSession(h, info.id, old);
    expect(texts(old).filter(isManualBrief)).toHaveLength(1);
    expect(fresh.sent[0].text).toContain(BRIEF);
    await settle();
    expect(h.fake.sessions).toHaveLength(2);
  });
});

describe("/handoff failures: no switch, and the conversation continues", () => {
  const cases: {
    name: string;
    answer: (s: FakeSession) => void;
    stop?: boolean;
  }[] = [
    {
      name: "a brief turn with no text",
      answer: (s) => s.completeTurn({ text: "   " }),
    },
    { name: "a brief turn the member stops", answer: () => {}, stop: true },
  ];
  for (const c of cases) {
    it(`${c.name}: a message sent meanwhile goes to the old session, and the automatic handoff stays available`, async () => {
      const h = makeHarness();
      let briefSession: FakeSession | null = null;
      h.brief.answer = (s) => {
        // Only the first brief, the manual one, takes the failing answer.
        if (briefSession === null) {
          briefSession = s;
          setTimeout(() => {
            if (!c.stop) c.answer(s);
          }, 50);
        } else s.completeTurn({ text: BRIEF });
      };
      const info = await spawn(h, { autoHandoff: true });
      // Below the automatic trigger.
      const old = await finishedTurn(h, info.id, ctx(100_000, 200_000));
      void h.mgr.sendMessage(info.id, "/handoff");
      await waitUntil(() => briefSession !== null, "brief turn sent");
      expect(isManualBrief(texts(old).at(-1)!)).toBe(true);
      void h.mgr.sendMessage(info.id, "DURING-MSG");
      if (c.stop) await h.mgr.abort(info.id);
      await waitUntil(
        () => systemLines(h).includes(failedLine),
        "failure line",
      );
      expect(systemLines(h)).not.toContain(handedOff);
      expect(systemLines(h)).not.toContain(
        en.t("systemEntries.autoHandoff.failed"),
      );
      // The message goes to the old conversation, not a fresh one.
      await waitUntil(
        () => sent(h.fake.sessionForAgent(info.id), "DURING-MSG"),
        "message delivered",
      );
      const cur = h.fake.sessionForAgent(info.id)!;
      expect(texts(cur).join("\n")).not.toContain(BRIEF);
      expect(sent(cur, "[Handoff from your previous session]")).toBe(false);

      // The failed manual attempt did not use the automatic one: a turn that
      // ends above the trigger arms it, and the next message hands off.
      await waitUntil(
        () => stateOf(h, info.id) === "thinking",
        "message turn running",
      );
      h.measure.now = ctx(190_000, 200_000);
      cur.completeTurn({ text: "done" });
      await waitUntil(
        () =>
          stateOf(h, info.id) === "waiting_for_response" &&
          h.mgr.getAgent(info.id)?.contextUsage?.totalTokens === 190_000,
        "at rest above the trigger",
      );
      void h.mgr.sendMessage(info.id, "LAST-MSG");
      const fresh = await freshSession(h, info.id, cur);
      expect(texts(cur).filter(isAutoBrief)).toHaveLength(1);
      expectInOrder(fresh.sent[0].text, [BRIEF, "LAST-MSG"]);
    });
  }

  it("a brief turn that fails leaves the agent in error, with the waiting message queued for the old session", async () => {
    const h = makeHarness();
    let briefSession: FakeSession | null = null;
    h.brief.answer = (s) => {
      briefSession = s;
    };
    const info = await spawn(h);
    const old = await finishedTurn(h, info.id);
    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(() => briefSession !== null, "brief turn sent");
    void h.mgr.sendMessage(info.id, "DURING-MSG");
    await waitUntil(
      () => queueOf(h, info.id)?.includes("DURING-MSG") === true,
      "DURING-MSG queued",
    );
    briefSession!.completeTurn({ status: "failed", error: "boom" });
    await waitUntil(() => systemLines(h).includes(failedLine), "failure line");
    // As any failed turn does; the message waits for the member.
    expect(stateOf(h, info.id)).toBe("error");
    expect(queueOf(h, info.id)).toEqual(["DURING-MSG"]);
    await settle();
    expect(h.fake.sessions).toHaveLength(1);
    expect(texts(old).filter(isManualBrief)).toHaveLength(1);
    expect(systemLines(h)).not.toContain(handedOff);
  });

  it("a brief turn the member's usage cap refuses", async () => {
    const claudeHome = join(STATE_ROOT, "claude-home");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
    const h = makeHarness();
    const info = await spawn(h);
    const old = await finishedTurn(h, info.id);
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
    void h.mgr.sendMessage(info.id, "/handoff");
    await waitUntil(() => systemLines(h).includes(failedLine), "failure line");
    expect(texts(old).some(isManualBrief)).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);
    // The phase is gone: an agent's message is not held for a handoff.
    h.mgr.enqueueMessage(info.id, { sender: SENDER, text: "AGENT-MSG" });
    await waitUntil(() => sent(old, "AGENT-MSG"), "agent message delivered");
  });
});

describe("/handoff: whose turn the brief turn is", () => {
  // The user store outlives the state dir reset in a multi-file run.
  function memberId(name: string): string {
    const known = getUserByName(name);
    if (known) return known.id;
    const created = createMember(name, { role: "member" });
    if (!created.ok) throw new Error(created.error);
    return created.user.id;
  }

  it("the brief turn of a member's /handoff is that member's turn (task 10d7ead6)", async () => {
    const morgan = memberId("Morgan");
    const riley = memberId("Riley");
    const h = makeHarness();
    const info = await spawn(h);
    // The turn before is another member's, so neither [] nor the last
    // turn's members passes.
    void h.mgr.sendMessage(info.id, "work", "Riley");
    await waitUntil(
      () =>
        stateOf(h, info.id) === "thinking" &&
        sent(h.fake.sessionForAgent(info.id), "] work"),
      "Riley's turn running",
    );
    const old = h.fake.sessionForAgent(info.id)!;
    old.completeTurn({ text: "done" });
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest after Riley's turn",
    );
    expect(h.mgr.getAgent(info.id)?.turnMemberIds).toEqual([riley]);

    let during: string[] | undefined;
    h.brief.answer = (s) => {
      during = [...(h.mgr.getAgent(info.id)?.turnMemberIds ?? [])];
      s.completeTurn({ text: BRIEF });
    };
    void h.mgr.sendMessage(info.id, "/handoff", "Morgan");
    await freshSession(h, info.id, old);
    expect(texts(old).filter(isManualBrief)).toHaveLength(1);
    expect(during).toEqual([morgan]);
  });
});
