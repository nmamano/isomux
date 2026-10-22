// Resume after a usage limit (server/limit-resume.ts). Seam: the DI manager
// (createAgentManager + FakeBackend) with an injected clock for the resume
// timers. A member's message starts each turn; the test plays the engine's
// usage_limit_stop and the turn's end, then moves the clock. The engine
// payloads behind usage_limit_stop are pinned in
// server/backends/claude.usage-limit.test.ts and the Codex block of
// server/backends/codex/adapter.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { removeStateDir } from "./temp-state.ts";
import { createAgentManager, type LimitResumeClock } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { translatorForLanguage } from "../i18n.ts";
import { loadAgents } from "../persistence.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import {
  LIMIT_RESUME_BOOT_DELAY_MS,
  LIMIT_RESUME_DELAY_MS,
  LIMIT_RESUME_MAX_WAIT_MS,
  LIMIT_RESUME_TEXT,
} from "../limit-resume.ts";
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
  clearTestManagedOfficeEnv();
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
// Long enough for a flush that is not supposed to happen to have happened.
const settle = () => sleep(100);

const HOUR = 60 * 60 * 1000;
const OTHER = {
  kind: "agent" as const,
  agentId: "agent-other",
  agentName: "Other",
  roomName: "room-a",
};
const en = translatorForLanguage("en");
const RESUMED = en.t("systemEntries.limitResume.resumed");
const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];

// The resume timers' clock. advance() runs every timer due by the new time,
// in order, as a real clock would.
function fakeClock() {
  let now = Date.now();
  const timers: { at: number; fn: () => void; done: boolean }[] = [];
  const clock: LimitResumeClock & {
    advance(ms: number): Promise<void>;
    pending(): number[];
  } = {
    now: () => now,
    setTimeout(fn, ms) {
      const t = { at: now + ms, fn, done: false };
      timers.push(t);
      return t;
    },
    clearTimeout(handle) {
      if (handle) (handle as { done: boolean }).done = true;
    },
    pending: () => timers.filter((t) => !t.done).map((t) => t.at - now),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers
          .filter((t) => !t.done && t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.done = true;
        next.fn();
        await sleep(0);
      }
      now = end;
    },
  };
  return clock;
}

interface Harness {
  mgr: ReturnType<typeof createAgentManager>;
  fake: FakeBackend;
  clock: ReturnType<typeof fakeClock>;
  logs: LogEntry[];
}

function makeHarness(
  initialRooms: Parameters<typeof createAgentManager>[0]["initialRooms"] = [],
  opts: {
    session?: ConstructorParameters<typeof FakeBackend>[0] extends infer C
      ? C extends { session?: infer S }
        ? S
        : never
      : never;
    sampleWaitMs?: number;
  } = {},
): Harness {
  const fake = new FakeBackend(opts.session ? { session: opts.session } : {});
  const clock = fakeClock();
  const logs: LogEntry[] = [];
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type === "log_entry" && ev.entry) logs.push(ev.entry);
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms,
    eventSink: sink,
    limitResumeClock: clock,
  });
  mgr.configureAgentTurnDeps(opts.sampleWaitMs);
  activeFakes.push(fake);
  return { mgr, fake, clock, logs };
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
  return info;
}

const stateOf = (h: Harness, id: string) => h.mgr.getAgent(id)?.state;
// The live queue (AgentInfo.queue is the wire copy getAllAgents fills).
const queueOf = (h: Harness, id: string) =>
  h.mgr.getAllAgents().find((a) => a.id === id)?.queue ?? [];
const texts = (s: FakeSession | undefined) =>
  (s?.sent ?? []).map((m) => m.text);
const resumesSent = (h: Harness) =>
  h.fake.sessions.flatMap(texts).filter((t) => t.includes(LIMIT_RESUME_TEXT))
    .length;
const persistedAt = (id: string) =>
  loadAgents()
    .flatMap((r) => r.agents)
    .find((a) => a.id === id)?.limitResumeAt;

// A member turn that a usage limit stops. `resetsAtMs` is what the engine
// reports; Codex ends such a turn failed, after an error.
async function limitedTurn(
  h: Harness,
  id: string,
  resetsAtMs: number,
  engine: "claude" | "codex" = "claude",
): Promise<FakeSession> {
  void h.mgr.sendMessage(id, "work");
  await waitUntil(
    () =>
      stateOf(h, id) === "thinking" &&
      texts(h.fake.sessionForAgent(id)).some((t) => t.endsWith("work")),
    "member turn running",
  );
  const s = h.fake.sessionForAgent(id)!;
  if (engine === "codex") {
    s.push({ kind: "error", message: "You've hit your usage limit." });
    s.push({ kind: "usage_limit_stop", resetsAtMs });
    s.push({
      kind: "turn_completed",
      status: "failed",
      error: "You've hit your usage limit.",
    });
    await waitUntil(() => stateOf(h, id) === "error", "codex stop: error");
  } else {
    s.push({ kind: "system_text", text: "You've hit your limit" });
    s.push({ kind: "usage_limit_stop", resetsAtMs });
    s.completeTurn();
    await waitUntil(
      () => stateOf(h, id) === "waiting_for_response",
      "claude stop: at rest",
    );
  }
  return s;
}

// Move the clock to the resume and let its flush run.
async function toResume(h: Harness, resetsAtMs: number) {
  await h.clock.advance(resetsAtMs + LIMIT_RESUME_DELAY_MS - h.clock.now());
  await settle();
}

describe("resume after a usage limit", () => {
  for (const engine of ["claude", "codex"] as const) {
    it(`${engine}: a stopped turn resumes a minute after the reset, once, with a member line`, async () => {
      const h = makeHarness();
      const info = await spawn(h, engine);
      const reset = h.clock.now() + 5 * HOUR;
      const s = await limitedTurn(h, info.id, reset, engine);
      expect(persistedAt(info.id)).toBe(reset + LIMIT_RESUME_DELAY_MS);

      // Not before the minute after the reset.
      await h.clock.advance(reset + LIMIT_RESUME_DELAY_MS - 1 - h.clock.now());
      await settle();
      expect(resumesSent(h)).toBe(0);

      await toResume(h, reset);
      await waitUntil(() => resumesSent(h) === 1, "resume sent");
      // The conversation stays: the resume goes to the same session.
      if (engine === "claude")
        expect(texts(s).some((t) => t.includes(LIMIT_RESUME_TEXT))).toBe(true);
      // The member reads a system line, not a message from the agent itself.
      expect(
        h.logs.some((e) => e.kind === "system" && e.content === RESUMED),
      ).toBe(true);
      expect(
        h.logs.some(
          (e) =>
            e.kind === "user_message" && e.content.includes(LIMIT_RESUME_TEXT),
        ),
      ).toBe(false);
      expect(persistedAt(info.id)).toBeUndefined();
      await h.clock.advance(10 * HOUR);
      await settle();
      expect(resumesSent(h)).toBe(1);
    });
  }
});

describe("resume after a usage limit: loop guard", () => {
  it("the resumed turn stopped again with the same reset time arms nothing", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.clock.now() + HOUR;
    await limitedTurn(h, info.id, reset);
    await toResume(h, reset);
    await waitUntil(
      () => resumesSent(h) === 1 && stateOf(h, info.id) === "thinking",
      "resumed turn running",
    );
    const s = h.fake.sessionForAgent(info.id)!;
    s.push({ kind: "usage_limit_stop", resetsAtMs: reset });
    s.completeTurn();
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    expect(persistedAt(info.id)).toBeUndefined();
    expect(h.clock.pending()).toEqual([]);
  });

  it("the resumed turn stopped again by a later reset arms from that reset", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.clock.now() + HOUR;
    await limitedTurn(h, info.id, reset);
    await toResume(h, reset);
    await waitUntil(
      () => resumesSent(h) === 1 && stateOf(h, info.id) === "thinking",
      "resumed turn running",
    );
    const weekly = h.clock.now() + 3 * 24 * HOUR;
    const s = h.fake.sessionForAgent(info.id)!;
    s.push({ kind: "usage_limit_stop", resetsAtMs: weekly });
    s.completeTurn();
    await waitUntil(
      () => persistedAt(info.id) === weekly + LIMIT_RESUME_DELAY_MS,
      "re-armed",
    );
  });

  it("a weekly reset waits through chained timers and fires once", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.clock.now() + 7 * 24 * HOUR;
    await limitedTurn(h, info.id, reset);
    expect(h.clock.pending()).toEqual([LIMIT_RESUME_MAX_WAIT_MS]);
    await h.clock.advance(LIMIT_RESUME_MAX_WAIT_MS);
    await settle();
    expect(resumesSent(h)).toBe(0);
    expect(h.clock.pending()).toEqual([LIMIT_RESUME_MAX_WAIT_MS]);
    await toResume(h, reset);
    await waitUntil(() => resumesSent(h) === 1, "resume sent");
    await settle();
    expect(resumesSent(h)).toBe(1);
  });
});

describe("resume after a usage limit: when it is dropped", () => {
  it("the agent works again before the reset", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.clock.now() + HOUR;
    const s = await limitedTurn(h, info.id, reset);
    void h.mgr.sendMessage(info.id, "a member asks again");
    await waitUntil(() => stateOf(h, info.id) === "thinking", "member turn");
    expect(persistedAt(info.id)).toBeUndefined();
    s.completeTurn({ text: "done" });
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await toResume(h, reset);
    expect(resumesSent(h)).toBe(0);
  });

  it("the switch goes off", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.clock.now() + HOUR;
    await limitedTurn(h, info.id, reset);
    await h.mgr.editAgent(info.id, { limitResume: false });
    expect(persistedAt(info.id)).toBeUndefined();
    await toResume(h, reset);
    expect(resumesSent(h)).toBe(0);
  });

  it("the agent is killed", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.clock.now() + HOUR;
    await limitedTurn(h, info.id, reset);
    await h.mgr.kill(info.id);
    expect(h.clock.pending()).toEqual([]);
    await toResume(h, reset);
    expect(resumesSent(h)).toBe(0);
  });

  it("the conversation is cleared", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.clock.now() + HOUR;
    await limitedTurn(h, info.id, reset);
    await h.mgr.newConversation(info.id);
    expect(persistedAt(info.id)).toBeUndefined();
    await toResume(h, reset);
    expect(resumesSent(h)).toBe(0);
  });

  it("a conversation change holds the queue at fire time: no resume, then or after", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.clock.now() + HOUR;
    await limitedTurn(h, info.id, reset);
    const release = h.mgr._testHoldQueue(info.id);
    await toResume(h, reset);
    release();
    await settle();
    expect(resumesSent(h)).toBe(0);
    expect(queueOf(h, info.id)).toEqual([]);
  });

  it("a flush already under way at fire time: no second turn", async () => {
    // The automatic handoff makes a flush wait for the turn's context
    // sample; this sample answers only when the test lets it.
    const sample: { release: (() => void) | null } = { release: null };
    const h = makeHarness([], {
      session: {
        contextUsage: () =>
          new Promise((res) => {
            sample.release = () => res(null);
          }),
      },
      sampleWaitMs: 10_000,
    });
    const info = await spawn(h);
    await h.mgr.editAgent(info.id, { autoHandoff: true });
    const reset = h.clock.now() + HOUR;
    const s = await limitedTurn(h, info.id, reset);
    // Another agent's message starts a flush, which waits for the sample.
    expect(
      h.mgr.enqueueMessage(info.id, { sender: OTHER, text: "a note" }).ok,
    ).toBe(true);
    await settle();
    expect(stateOf(h, info.id)).toBe("waiting_for_response");
    // Still armed while the flush is parked.
    expect(persistedAt(info.id)).toBe(reset + LIMIT_RESUME_DELAY_MS);
    await toResume(h, reset);
    // The fire ran and skipped.
    expect(persistedAt(info.id)).toBeUndefined();
    expect(queueOf(h, info.id).map((m) => m.text)).toEqual(["a note"]);
    sample.release?.();
    await waitUntil(
      () =>
        stateOf(h, info.id) === "thinking" &&
        texts(s).some((t) => t.includes("a note")),
      "the note's turn running",
    );
    s.completeTurn({ text: "done" });
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await settle();
    expect(resumesSent(h)).toBe(0);
    expect(queueOf(h, info.id)).toEqual([]);
  });

  it("a queued resume does not move to another conversation", async () => {
    // The resume item is in the queue at a conversation change: a queue
    // persisted at a restart, before its first flush, is in this state.
    const h = makeHarness();
    const info = await spawn(h);
    void h.mgr.sendMessage(info.id, "work");
    await waitUntil(() => stateOf(h, info.id) === "thinking", "member turn");
    const old = h.fake.sessionForAgent(info.id)!;
    const self = { ...OTHER, agentId: info.id, agentName: info.name };
    expect(
      h.mgr.enqueueMessage(info.id, {
        sender: self,
        text: LIMIT_RESUME_TEXT,
        limitResume: true,
      }).ok,
    ).toBe(true);
    expect(
      h.mgr.enqueueMessage(info.id, { sender: OTHER, text: "carried note" }).ok,
    ).toBe(true);
    await h.mgr.newConversation(info.id);
    await waitUntil(() => {
      const cur = h.fake.sessionForAgent(info.id);
      return (
        !!cur &&
        cur !== old &&
        texts(cur).some((t) => t.includes("carried note"))
      );
    }, "carried note in the new conversation");
    await settle();
    expect(resumesSent(h)).toBe(0);
    expect(queueOf(h, info.id).some((m) => m.limitResume)).toBe(false);
  });

  it("the switch off at the stop arms nothing", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await h.mgr.editAgent(info.id, { limitResume: false });
    await limitedTurn(h, info.id, h.clock.now() + HOUR);
    expect(persistedAt(info.id)).toBeUndefined();
    expect(h.clock.pending()).toEqual([]);
  });

  it("an errored agent whose conversation cannot resume: the send is refused and nothing re-arms", async () => {
    const h = makeHarness();
    const info = await spawn(h, "codex");
    const reset = h.clock.now() + HOUR;
    const s = await limitedTurn(h, info.id, reset, "codex");
    h.fake.setStoredSessionState(s.sessionId, "missing");
    expect(persistedAt(info.id)).toBe(reset + LIMIT_RESUME_DELAY_MS);
    await toResume(h, reset);
    // The fire ran (it clears the stored time), and the refused send left the
    // agent in error with nothing queued.
    expect(persistedAt(info.id)).toBeUndefined();
    expect(stateOf(h, info.id)).toBe("error");
    expect(queueOf(h, info.id)).toEqual([]);
    expect(resumesSent(h)).toBe(0);
    expect(h.clock.pending()).toEqual([]);
  });
});

describe("resume after a usage limit: restart", () => {
  // A restored Claude agent wakes by resuming its session, which the resume
  // preflight looks for on disk: point CLAUDE_CONFIG_DIR at a temp home and
  // put the session file there.
  const claudeHome = () => join(STATE_ROOT, "claude-home-limit-resume");
  function seedClaudeSession(sessionId: string): void {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const dir = claudeProjectDir(STATE_ROOT, {
      CLAUDE_CONFIG_DIR: claudeHome(),
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), "");
  }

  const persisted = (
    id: string,
    over: { lastSessionId: string | null; limitResumeAt?: number },
  ) => ({
    id,
    name: id,
    desk: 0,
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
    topic: null,
    customInstructions: null,
    userId: null,
    username: null,
    ...over,
  });

  it("a resume due during downtime fires shortly after boot, in the restored conversation", async () => {
    seedClaudeSession("s-old");
    const dueAt = Date.now() - HOUR;
    const h = makeHarness([
      {
        id: "room-a",
        name: "room-a",
        prompt: null,
        agents: [
          persisted("stopped", {
            lastSessionId: "s-old",
            limitResumeAt: dueAt,
          }),
        ],
      },
    ]);
    await h.mgr.restoreAgents();
    expect(h.clock.pending()).toEqual([LIMIT_RESUME_BOOT_DELAY_MS]);
    expect(persistedAt("stopped")).toBe(dueAt);
    await h.clock.advance(LIMIT_RESUME_BOOT_DELAY_MS);
    await waitUntil(() => resumesSent(h) === 1, "resume sent after boot");
    const s = h.fake.sessionForAgent("stopped")!;
    expect(s.isResume).toBe(true);
    expect(s.sessionId).toBe("s-old");
    expect(persistedAt("stopped")).toBeUndefined();
  });

  it("a pending resume with no conversation to continue is not restored", async () => {
    const h = makeHarness([
      {
        id: "room-a",
        name: "room-a",
        prompt: null,
        agents: [
          persisted("blank", {
            lastSessionId: null,
            limitResumeAt: Date.now() + HOUR,
          }),
        ],
      },
    ]);
    await h.mgr.restoreAgents();
    expect(h.clock.pending()).toEqual([]);
    expect(persistedAt("blank")).toBeUndefined();
  });
});
