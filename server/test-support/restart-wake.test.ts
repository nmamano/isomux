// Wake after a server restart (server/restart-wake.ts). Seam: the DI manager
// (createAgentManager + FakeBackend) with an injected clock for the clear
// delay and the spread wakes, and an injected serverStopping(). A restart is a
// second manager on the same state root, built from agents.json the way the
// office boots (loadAgents()); the first one is left as it was, as a crash
// leaves it. The record is read from disk, where the next boot reads it.
// The record is a file only this test file uses (turnsInFlightFile): managers
// that an earlier test file in the same bun process left behind run their
// clear timers on the real clock and rewrite the default record file.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
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
import { loadAgents, loadMessageQueuesRaw } from "../persistence.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import {
  RESTART_WAKE_BOOT_DELAY_MS,
  RESTART_WAKE_CLEAR_DELAY_MS,
  RESTART_WAKE_INTERVAL_MS,
  RESTART_WAKE_TEXT,
} from "../restart-wake.ts";
import type { EventHandler } from "../internal-types.ts";
import type { AgentInfo, LogEntry, RoomWire } from "../../shared/types.ts";

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

// turns-in-flight.json as the next boot reads it.
const RECORD_FILE = join(STATE_ROOT, "restart-wake", "turns-in-flight.json");

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
const en = translatorForLanguage("en");
const RESUMED = en.t("systemEntries.restartWake.resumed");
const AFTER_RESTART = en.t("systemEntries.wake.afterRestart");
const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];
type Engine = AgentInfo["agentType"];
const ENGINES: Engine[] = ["claude", "codex", "opencode"];

// The timers' clock. advance() runs every timer due by the new time, in
// order, as a real clock would.
function fakeClock() {
  let now = Date.now();
  const timers: { at: number; fn: () => void; done: boolean }[] = [];
  const clock: LimitResumeClock & { advance(ms: number): Promise<void> } = {
    now: () => now,
    setTimeout(fn, ms) {
      const t = { at: now + ms, fn, done: false };
      timers.push(t);
      return t;
    },
    clearTimeout(handle) {
      if (handle) (handle as { done: boolean }).done = true;
    },
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
  stopping: { value: boolean };
}

function makeHarness(
  initialRooms: Parameters<typeof createAgentManager>[0]["initialRooms"] = [],
  opts: {
    manualSend?: boolean;
    // The sink throws once, at the first entry this picks.
    sinkThrowsAt?: (entry: LogEntry) => boolean;
  } = {},
): Harness {
  const fake = new FakeBackend(
    opts.manualSend ? { session: { manualSend: true } } : {},
  );
  const clock = fakeClock();
  const logs: LogEntry[] = [];
  const stopping = { value: false };
  let thrown = false;
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type !== "log_entry" || !ev.entry) return;
    if (!thrown && opts.sinkThrowsAt?.(ev.entry)) {
      thrown = true;
      throw new Error("sink failed");
    }
    logs.push(ev.entry);
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms,
    eventSink: sink,
    restartWakeClock: clock,
    turnsInFlightFile: RECORD_FILE,
    serverStopping: () => stopping.value,
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(fake);
  return { mgr, fake, clock, logs, stopping };
}

async function spawn(
  h: Harness,
  agentType: Engine = "claude",
  name = "Receiver",
) {
  const info = await h.mgr.spawn(
    name,
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
const busy = (h: Harness, id: string) =>
  stateOf(h, id) === "thinking" || stateOf(h, id) === "tool_executing";
const queueOf = (h: Harness, id: string) =>
  h.mgr.getAllAgents().find((a) => a.id === id)?.queue ?? [];
const texts = (s: FakeSession | undefined) =>
  (s?.sent ?? []).map((m) => m.text);
const sentTo = (h: Harness, id: string) =>
  h.fake.sessions.filter((s) => s.opts.agentId === id).flatMap(texts);
const wakesTo = (h: Harness, id: string) =>
  sentTo(h, id).filter((t) => t.includes(RESTART_WAKE_TEXT)).length;

type DiskRecord = Record<string, { since: number; restartWake?: true }>;
const onDisk = (): DiskRecord =>
  existsSync(RECORD_FILE)
    ? (JSON.parse(readFileSync(RECORD_FILE, "utf-8")) as DiskRecord)
    : {};
const seedRecord = (record: DiskRecord) => {
  mkdirSync(dirname(RECORD_FILE), { recursive: true });
  writeFileSync(RECORD_FILE, JSON.stringify(record));
};

// A member turn, running.
async function memberTurn(h: Harness, id: string, text: string) {
  void h.mgr.sendMessage(id, text);
  await waitUntil(
    () => busy(h, id) && sentTo(h, id).some((t) => t.includes(text)),
    `turn "${text}" running`,
  );
  return h.fake.sessionForAgent(id)!;
}
async function endTurn(h: Harness, id: string) {
  h.fake.sessionForAgent(id)!.completeTurn({ text: "done" });
  await waitUntil(() => !busy(h, id), "turn ended");
}
// Past the clear delay, with the clear's effects settled.
async function pastClearDelay(h: Harness) {
  await h.clock.advance(RESTART_WAKE_CLEAR_DELAY_MS);
  await settle();
}

// A restored Claude agent wakes by resuming its session, which the resume
// preflight looks for on disk: point CLAUDE_CONFIG_DIR at a temp home and put
// the session file there.
const claudeHome = () => join(STATE_ROOT, "claude-home-restart-wake");
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
  agentType: Engine,
  lastSessionId: string | null,
) => {
  if (agentType === "claude" && lastSessionId) seedClaudeSession(lastSessionId);
  return {
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
    agentType,
    topic: null,
    customInstructions: null,
    userId: null,
    username: null,
    lastSessionId,
  };
};
const roomWith = (...agents: ReturnType<typeof persisted>[]) => [
  { id: "room-a", name: "room-a", prompt: null, agents },
];

// A booted office: agents restored from `agents`, the record seeded first.
async function boot(
  record: DiskRecord,
  agents: ReturnType<typeof persisted>[],
  opts: { manualSend?: boolean } = {},
): Promise<Harness> {
  seedRecord(record);
  const h = makeHarness(roomWith(...agents), opts);
  await h.mgr.restoreAgents();
  return h;
}

// The next boot on the same state root, from agents.json as the office boots.
// The previous manager is left as it is, as a crash leaves it.
async function restart(): Promise<Harness> {
  const loaded = loadAgents();
  for (const a of loaded.flatMap((r) => r.agents))
    if (a.agentType === "claude" && a.lastSessionId)
      seedClaudeSession(a.lastSessionId);
  const h = makeHarness(loaded);
  await h.mgr.restoreAgents();
  return h;
}

// Move the clock to the first batch of wakes and let it run.
async function toFirstWakes(h: Harness) {
  await h.clock.advance(RESTART_WAKE_BOOT_DELAY_MS);
  await settle();
}

describe("the record of a turn in flight", () => {
  for (const engine of ENGINES) {
    it(`${engine}: on disk from the turn's start, gone after it ends`, async () => {
      const h = makeHarness();
      const info = await spawn(h, engine);
      expect(onDisk()[info.id]).toBeUndefined();
      const before = Date.now();
      await memberTurn(h, info.id, "work");
      // Read at once: a crash a moment after the start must find it.
      const entry = onDisk()[info.id];
      expect(entry?.since).toBeGreaterThanOrEqual(before);
      expect(entry?.restartWake).toBeUndefined();
      await endTurn(h, info.id);
      await pastClearDelay(h);
      expect(onDisk()[info.id]).toBeUndefined();
    });
  }

  it("a turn end while the server stops keeps the record, whichever comes first", async () => {
    // Stop signal first, then the backend dies and the turn ends.
    const h = makeHarness();
    const first = await spawn(h);
    await memberTurn(h, first.id, "work");
    h.stopping.value = true;
    await endTurn(h, first.id);
    await pastClearDelay(h);
    expect(onDisk()[first.id]).toBeDefined();

    // The turn ends first, and the stop signal comes within the delay.
    const h2 = makeHarness();
    const second = await spawn(h2);
    await memberTurn(h2, second.id, "work");
    await endTurn(h2, second.id);
    h2.stopping.value = true;
    await pastClearDelay(h2);
    expect(onDisk()[second.id]).toBeDefined();
  });

  it("a member's Stop of a running turn removes the record", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await memberTurn(h, info.id, "work");
    expect(onDisk()[info.id]).toBeDefined();
    await h.mgr.abort(info.id);
    await waitUntil(() => !busy(h, info.id), "stopped");
    await pastClearDelay(h);
    expect(onDisk()[info.id]).toBeUndefined();
  });

  it("a turn parked at a permission prompt keeps its record; a member's Stop there removes it", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const s = await memberTurn(h, info.id, "work");
    s.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "ls" },
    });
    await waitUntil(
      () => h.mgr.getAgent(info.id)?.pendingPrompt === "permission",
      "parked on a permission prompt",
    );
    await pastClearDelay(h);
    expect(onDisk()[info.id]).toBeDefined();
    await h.mgr.abort(info.id);
    await waitUntil(
      () => h.mgr.getAgent(info.id)?.pendingPrompt === null,
      "prompt denied",
    );
    await pastClearDelay(h);
    expect(onDisk()[info.id]).toBeUndefined();
  });

  it("killing the agent removes the record", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const other = await spawn(h, "claude", "Other");
    await memberTurn(h, info.id, "work");
    await memberTurn(h, other.id, "work");
    await h.mgr.kill(info.id);
    expect(Object.keys(onDisk())).toEqual([other.id]);
  });
});

describe("wake after a restart", () => {
  for (const engine of ENGINES) {
    it(`${engine}: an agent cut mid-turn continues by itself, once; an idle one stays asleep`, async () => {
      const h = await boot({ cut: { since: Date.now() - 1000 } }, [
        persisted("cut", engine, "s-cut"),
        persisted("idle", engine, "s-idle"),
      ]);
      await h.clock.advance(RESTART_WAKE_BOOT_DELAY_MS - 1);
      await settle();
      expect(h.fake.sessions).toHaveLength(0);

      await h.clock.advance(1);
      await waitUntil(() => wakesTo(h, "cut") === 1, "wake sent");
      const s = h.fake.sessionForAgent("cut")!;
      // The same conversation continues, behind the after-restart notice.
      // The wake is a line of its own: no sender prefix, as the agent sent
      // it to itself.
      expect(s.isResume).toBe(true);
      expect(s.sessionId).toBe("s-cut");
      expect(
        texts(s).some(
          (t) =>
            t.split("\n").includes(RESTART_WAKE_TEXT) &&
            t.includes(AFTER_RESTART),
        ),
      ).toBe(true);
      // The member reads a system line, not a message from the agent itself.
      expect(
        h.logs.some((e) => e.kind === "system" && e.content === RESUMED),
      ).toBe(true);
      expect(
        h.logs.some(
          (e) =>
            e.kind === "user_message" && e.content.includes(RESTART_WAKE_TEXT),
        ),
      ).toBe(false);
      // The woken turn is on record as one a wake started.
      await waitUntil(() => busy(h, "cut"), "woken turn running");
      expect(onDisk().cut?.restartWake).toBe(true);

      await endTurn(h, "cut");
      await h.clock.advance(10 * HOUR);
      await settle();
      expect(wakesTo(h, "cut")).toBe(1);
      expect(onDisk().cut).toBeUndefined();
      expect(h.fake.sessionForAgent("idle")).toBeUndefined();
      expect(h.mgr.getAgent("idle")?.dormant).toBe(true);
    });
  }

  it("a turn that a wake started is not woken again when a restart cuts it", async () => {
    const h1 = await boot({ cut: { since: Date.now() - 1000 } }, [
      persisted("cut", "claude", "s-cut"),
      persisted("member", "claude", "s-member"),
    ]);
    await toFirstWakes(h1);
    await waitUntil(() => busy(h1, "cut"), "woken turn running");
    // A member's turn runs at the same restart: the control that this boot
    // wakes at all.
    await memberTurn(h1, "member", "work");

    const h2 = await restart();
    await h2.clock.advance(10 * HOUR);
    await waitUntil(() => wakesTo(h2, "member") === 1, "member's agent woken");
    expect(h2.fake.sessionForAgent("cut")).toBeUndefined();
    expect(onDisk().cut).toBeUndefined();
  });

  it("a wake whose turn started but whose send never landed is not sent again", async () => {
    // The turn starts before the send is accepted, and the queue item goes
    // only when it is: a restart between the two finds both on disk.
    const h1 = await boot(
      { cut: { since: Date.now() - 1000 } },
      [persisted("cut", "claude", "s-cut")],
      { manualSend: true },
    );
    await toFirstWakes(h1);
    await waitUntil(() => busy(h1, "cut"), "woken turn started");
    // A member's message waits behind it.
    void h1.mgr.sendMessage("cut", "member follow-up");
    await waitUntil(() => queueOf(h1, "cut").length === 2, "both queued");
    expect(onDisk().cut?.restartWake).toBe(true);
    const queued = loadMessageQueuesRaw().cut as {
      queue: { text: string; restartWake?: boolean }[];
    };
    expect(queued.queue.map((m) => !!m.restartWake)).toEqual([true, false]);

    const h2 = await restart();
    await waitUntil(
      () => sentTo(h2, "cut").some((t) => t.includes("member follow-up")),
      "member's message replayed",
    );
    await h2.clock.advance(10 * HOUR);
    await settle();
    expect(wakesTo(h2, "cut")).toBe(0);
  });

  it("a boot that ends before its wakes go out leaves them to the next boot", async () => {
    const h1 = await boot({ cut: { since: Date.now() - 1000 } }, [
      persisted("cut", "claude", "s-cut"),
    ]);
    expect(onDisk().cut).toBeDefined();
    expect(onDisk().cut?.restartWake).toBeUndefined();

    const h2 = await restart();
    await toFirstWakes(h2);
    await waitUntil(() => wakesTo(h2, "cut") === 1, "wake sent by boot 2");
    expect(h1.fake.sessions).toHaveLength(0);
  });

  it("an entry for an agent that is gone or has no conversation gets no wake and leaves the record", async () => {
    const h = await boot(
      {
        cut: { since: Date.now() - 1000 },
        blank: { since: Date.now() - 1000 },
        ghost: { since: Date.now() - 1000 },
      },
      [persisted("cut", "claude", "s-cut"), persisted("blank", "claude", null)],
    );
    expect(Object.keys(onDisk())).toEqual(["cut"]);
    await h.clock.advance(10 * HOUR);
    await waitUntil(() => wakesTo(h, "cut") === 1, "cut agent woken");
    expect(h.fake.sessionForAgent("blank")).toBeUndefined();
  });

  it("wakes go out a few at a time, oldest turn first", async () => {
    const t = Date.now() - HOUR;
    const ids = ["a", "b", "c", "d", "e"];
    const h = await boot(
      {
        a: { since: t + 5 },
        b: { since: t + 1 },
        c: { since: t + 4 },
        d: { since: t + 2 },
        e: { since: t + 3 },
      },
      ids.map((id) => persisted(id, "codex", `s-${id}`)),
    );
    const woken = () => ids.filter((id) => wakesTo(h, id) > 0);
    await toFirstWakes(h);
    await waitUntil(() => woken().length === 3, "first batch");
    await settle();
    expect(woken()).toEqual(["b", "d", "e"]);
    await h.clock.advance(RESTART_WAKE_INTERVAL_MS);
    await waitUntil(() => woken().length === 5, "second batch");
  });

  it("an agent with queued messages at boot gets its wake with them, at once", async () => {
    const h1 = makeHarness();
    const info = await spawn(h1);
    await memberTurn(h1, info.id, "first");
    void h1.mgr.sendMessage(info.id, "second");
    await waitUntil(() => queueOf(h1, info.id).length === 1, "second queued");

    const h2 = await restart();
    await waitUntil(
      () => sentTo(h2, info.id).some((t) => t.includes("second")),
      "queue replayed",
    );
    expect(
      sentTo(h2, info.id).some(
        (t) => t.includes(RESTART_WAKE_TEXT) && t.includes("second"),
      ),
    ).toBe(true);
    await endTurn(h2, info.id);
    await h2.clock.advance(10 * HOUR);
    await settle();
    expect(wakesTo(h2, info.id)).toBe(1);
  });

  it("an agent that a member's message starts before its wake gets no wake after", async () => {
    const h = await boot({ cut: { since: Date.now() - 1000 } }, [
      persisted("cut", "claude", "s-cut"),
    ]);
    expect(onDisk().cut).toBeDefined();
    await memberTurn(h, "cut", "status?");
    await endTurn(h, "cut");
    await h.clock.advance(10 * HOUR);
    await settle();
    expect(wakesTo(h, "cut")).toBe(0);
    // The member's turn was an ordinary one, and its record is gone.
    expect(onDisk().cut).toBeUndefined();
  });

  it("the turn after a woken turn is on record as its own turn", async () => {
    const h = await boot({ cut: { since: Date.now() - 1000 } }, [
      persisted("cut", "claude", "s-cut"),
    ]);
    await toFirstWakes(h);
    await waitUntil(() => busy(h, "cut"), "woken turn running");
    void h.mgr.sendMessage("cut", "next task");
    await waitUntil(() => queueOf(h, "cut").length === 1, "next queued");
    // The next turn starts at once, inside the clear delay.
    h.fake.sessionForAgent("cut")!.completeTurn({ text: "done" });
    await waitUntil(
      () =>
        busy(h, "cut") && sentTo(h, "cut").some((t) => t.includes("next task")),
      "next turn running",
    );
    expect(onDisk().cut).toBeDefined();
    expect(onDisk().cut?.restartWake).toBeUndefined();
  });

  it("a woken turn keeps its mark through a permission prompt", async () => {
    const h = await boot({ cut: { since: Date.now() - 1000 } }, [
      persisted("cut", "claude", "s-cut"),
    ]);
    await toFirstWakes(h);
    await waitUntil(() => busy(h, "cut"), "woken turn running");
    const s = h.fake.sessionForAgent("cut")!;
    s.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "ls" },
    });
    await waitUntil(
      () => h.mgr.getAgent("cut")?.pendingPrompt === "permission",
      "parked",
    );
    void h.mgr.sendMessage("cut", "1");
    await waitUntil(() => s.approvals.length === 1, "approved");
    await waitUntil(() => busy(h, "cut"), "busy again");
    expect(onDisk().cut?.restartWake).toBe(true);
  });
});

// Background work that a restart or a backend end took with it (task
// e7fd8ddf). The office keeps the list in agents.json while it runs, so the
// next boot knows it; the agent's first wake after that names it, once.
describe("background work a restart ended", () => {
  const AFTER_BACKEND_ENDED = en.t("systemEntries.wake.afterBackendEnded");
  const WORK = [
    { id: "b1", kind: "command" as const, label: "bun run safe-push" },
    { id: "a1", kind: "agent" as const, label: "Review the diff" },
  ];
  const names = (t: string) => WORK.filter((w) => t.includes(w.label)).length;
  // The member's next message, and the text the agent got with it.
  async function nextTurnText(h: Harness, id: string, text: string) {
    await memberTurn(h, id, text);
    const sent = sentTo(h, id).find((t) => t.includes(text))!;
    await endTurn(h, id);
    return sent;
  }
  // An agent with a finished turn (so it has a conversation to resume)
  // whose session now runs WORK.
  async function runningWork(h: Harness, engine: Engine) {
    const info = await spawn(h, engine);
    await memberTurn(h, info.id, "start");
    await endTurn(h, info.id);
    await pastClearDelay(h);
    const session = h.fake.sessionForAgent(info.id)!;
    session.push({ kind: "background_tasks", tasks: WORK });
    await waitUntil(
      () => h.mgr.getAgent(info.id)?.backgroundTasks?.length === 2,
      "work running",
    );
    return { id: info.id, session };
  }

  for (const engine of ["claude", "codex"] as const) {
    it(`${engine}: the stop ends the work; the first wake after the restart names it, the next one does not`, async () => {
      const h1 = makeHarness();
      const { id, session } = await runningWork(h1, engine);
      // The stop: the signal, then the backend reports its work gone and dies
      // with it.
      h1.stopping.value = true;
      session.push({ kind: "background_tasks", tasks: [] });
      session.failStream(new Error("process exited with code 143"));
      await waitUntil(
        () => (h1.mgr.getAgent(id)?.backgroundTasks ?? null) === null,
        "live list cleared",
      );
      await settle();

      const h2 = await restart();
      expect(h2.mgr.getAgent(id)?.dormant).toBe(true);
      const woken = await nextTurnText(h2, id, "after restart");
      expect(woken).toContain(AFTER_RESTART);
      expect(names(woken)).toBe(2);
      // The member reads it too.
      expect(
        h2.logs.filter(
          (e) =>
            e.kind === "system" &&
            WORK.every((w) => JSON.stringify(e).includes(w.label)),
        ),
      ).toHaveLength(1);
      expect(names(await nextTurnText(h2, id, "same session"))).toBe(0);

      // Named once: the next restart does not name it again.
      const h3 = await restart();
      const again = await nextTurnText(h3, id, "second restart");
      expect(again).toContain(AFTER_RESTART);
      expect(names(again)).toBe(0);
    });
  }

  it("a backend that dies before the stop signal is seen still leaves the list for the next boot", async () => {
    const h1 = makeHarness();
    const { id, session } = await runningWork(h1, "claude");
    session.endStream();
    await waitUntil(() => h1.mgr.getAgent(id)?.dormant === true, "dormant");
    h1.stopping.value = true;
    await settle();

    const h2 = await restart();
    const woken = await nextTurnText(h2, id, "after restart");
    expect(woken).toContain(AFTER_RESTART);
    expect(names(woken)).toBe(2);
  });

  it("a crash with the work still running leaves the list for the next boot", async () => {
    const h1 = makeHarness();
    const { id } = await runningWork(h1, "claude");
    // h1 is left as a crash leaves it: no stop, no clear.
    const h2 = await restart();
    expect(names(await nextTurnText(h2, id, "after crash"))).toBe(2);
  });

  it("work that ended before the restart is not named", async () => {
    const h1 = makeHarness();
    const { id, session } = await runningWork(h1, "claude");
    session.push({ kind: "background_tasks", tasks: [] });
    await waitUntil(
      () => (h1.mgr.getAgent(id)?.backgroundTasks ?? null) === null,
      "work ended",
    );
    await settle();
    h1.stopping.value = true;
    session.failStream(new Error("process exited with code 143"));
    await settle();

    const h2 = await restart();
    const woken = await nextTurnText(h2, id, "after restart");
    expect(woken).toContain(AFTER_RESTART);
    expect(names(woken)).toBe(0);
  });

  it("a stream error before the stop signal is seen still leaves the list for the next boot", async () => {
    const h1 = makeHarness();
    const { id, session } = await runningWork(h1, "claude");
    session.failStream(new Error("process exited with code 143"));
    await waitUntil(
      () => (h1.mgr.getAgent(id)?.backgroundTasks ?? null) === null,
      "live list cleared",
    );
    h1.stopping.value = true;
    await settle();

    const h2 = await restart();
    const woken = await nextTurnText(h2, id, "after restart");
    expect(woken).toContain(AFTER_RESTART);
    expect(names(woken)).toBe(2);
  });

  it("a backend that ends with no restart: the next wake names the work, once", async () => {
    const h = makeHarness();
    const { id, session } = await runningWork(h, "claude");
    session.endStream();
    await waitUntil(() => h.mgr.getAgent(id)?.dormant === true, "dormant");
    const woken = await nextTurnText(h, id, "after the end");
    expect(woken).toContain(AFTER_BACKEND_ENDED);
    expect(names(woken)).toBe(2);
    expect(names(await nextTurnText(h, id, "same session"))).toBe(0);
  });
});

// A restart reads as one short line in the member's chat (task 51c187f4):
// the queue's restart line. The backend's death at the stop writes no error,
// in either order of the stop signal and the death (every backend dies with
// the server, and either can be seen first), and the wake writes neither its
// own restart sentence nor the interruption marker. The agent still gets the
// whole notice. A backend that dies with no stop still shows its error.
describe("one line for a restart", () => {
  const IN_FLIGHT = en.t("systemEntries.wake.inFlightWarning");
  const REJECTION = en.t("systemEntries.wake.shutdownRejection");
  const INTERRUPTED = en.t("systemEntries.previousInterrupted");
  // The SDK's words when the stop's SIGTERM ends the Claude CLI.
  const DEATH = "Claude Code process terminated by signal SIGTERM";
  type Order = "stop first" | "backend first";
  const ORDERS: Order[] = ["stop first", "backend first"];
  // What the member reads besides messages and replies.
  const linesFrom = (h: Harness, from = 0) =>
    h.logs
      .slice(from)
      .filter((e) => e.kind === "system" || e.kind === "error")
      .map((e) => `${e.kind}: ${e.content}`);

  // A spawned Claude agent's conversation, on disk where a resume looks.
  async function working(h: Harness, engine: Engine, name?: string) {
    if (engine === "claude")
      setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const info = await spawn(h, engine, name);
    const session = await memberTurn(h, info.id, "work");
    if (engine === "claude") seedClaudeSession(session.sessionId);
    return { info, session };
  }

  // The stop cuts the turn running in `session`.
  async function cut(
    h: Harness,
    id: string,
    session: FakeSession,
    order: Order,
  ) {
    if (order === "stop first") h.stopping.value = true;
    session.failStream(new Error(DEATH));
    await waitUntil(() => !busy(h, id), "turn cut");
    h.stopping.value = true;
    await pastClearDelay(h);
  }
  // The next boot's wake of `id`, settled.
  async function wokenAfterRestart(id: string) {
    const h = await restart();
    await toFirstWakes(h);
    await waitUntil(() => wakesTo(h, id) === 1, "woken");
    await settle();
    return h;
  }

  for (const engine of ENGINES)
    for (const order of ORDERS)
      it(`${engine}, ${order}: the cut turn shows no error, and the wake one line`, async () => {
        const h1 = makeHarness();
        const { info, session } = await working(h1, engine);
        const from = h1.logs.length;
        await cut(h1, info.id, session, order);
        expect({ engine, order, lines: linesFrom(h1, from) }).toEqual({
          engine,
          order,
          lines: [],
        });
        // The record that makes the next boot wake it.
        expect(onDisk()[info.id]).toBeDefined();

        const h2 = await wokenAfterRestart(info.id);
        expect({ engine, order, lines: linesFrom(h2) }).toEqual({
          engine,
          order,
          lines: [`system: ${RESUMED}`],
        });
        // The agent reads the whole notice with its wake.
        const woken = sentTo(h2, info.id).find((t) =>
          t.includes(RESTART_WAKE_TEXT),
        )!;
        expect(woken).toContain(AFTER_RESTART);
        expect(woken).toContain(IN_FLIGHT);
      });

  for (const order of ORDERS)
    it(`a turn the queue started, ${order}: no flush error either`, async () => {
      const h1 = makeHarness();
      const { info } = await working(h1, "claude");
      void h1.mgr.sendMessage(info.id, "second");
      await waitUntil(() => queueOf(h1, info.id).length === 1, "queued");
      h1.fake.sessionForAgent(info.id)!.completeTurn({ text: "done" });
      await waitUntil(
        () =>
          busy(h1, info.id) &&
          sentTo(h1, info.id).some((t) => t.includes("second")),
        "queued turn running",
      );
      const from = h1.logs.length;
      await cut(h1, info.id, h1.fake.sessionForAgent(info.id)!, order);
      expect({ order, lines: linesFrom(h1, from) }).toEqual({
        order,
        lines: [],
      });
      expect(onDisk()[info.id]).toBeDefined();
      const h2 = await wokenAfterRestart(info.id);
      expect({ order, lines: linesFrom(h2) }).toEqual({
        order,
        lines: [`system: ${RESUMED}`],
      });
    });

  it("a backend that dies with no stop still shows its error, in a member's turn and a queued one", async () => {
    const h = makeHarness();
    const { info, session } = await working(h, "claude");
    let from = h.logs.length;
    session.failStream(new Error(DEATH));
    await waitUntil(() => !busy(h, info.id), "turn ended");
    await pastClearDelay(h);
    expect(linesFrom(h, from).some((l) => l.startsWith("error: "))).toBe(true);

    const { info: other } = await working(h, "claude", "Other");
    void h.mgr.sendMessage(other.id, "second");
    await waitUntil(() => queueOf(h, other.id).length === 1, "queued");
    h.fake.sessionForAgent(other.id)!.completeTurn({ text: "done" });
    await waitUntil(
      () =>
        busy(h, other.id) &&
        sentTo(h, other.id).some((t) => t.includes("second")),
      "queued turn running",
    );
    from = h.logs.length;
    h.fake.sessionForAgent(other.id)!.failStream(new Error(DEATH));
    await waitUntil(() => !busy(h, other.id), "queued turn ended");
    await pastClearDelay(h);
    expect(linesFrom(h, from).some((l) => l.startsWith("error: "))).toBe(true);
  });

  // Which deaths wait for the stop: each engine's words for a death by a
  // signal or a cut stream. Any other death writes at once, stop or not.
  const STOP_DEATHS = [
    DEATH,
    "Claude Code process exited with code 143",
    "Claude Code process exited with code 137",
    "codex subprocess exited (signal SIGTERM) mid-turn",
    "codex subprocess exited (code 143) mid-turn",
    "OpenCode event stream failed (Error/ConnectionRefused; HTTP status: unavailable).",
  ];
  const OTHER_DEATHS = [
    "Claude Code process exited with code 1",
    "Selected model is at capacity. Please try a different model.",
  ];
  async function errorsAfter(end: (s: FakeSession) => void, stop: boolean) {
    const h = makeHarness();
    const { info, session } = await working(h, "claude");
    const from = h.logs.length;
    end(session);
    await waitUntil(() => !busy(h, info.id), "turn ended");
    h.stopping.value = stop;
    await pastClearDelay(h);
    return linesFrom(h, from).filter((l) => l.startsWith("error: ")).length;
  }
  const stopEnds: [string, (s: FakeSession) => void][] = [
    ...STOP_DEATHS.map((raw): [string, (s: FakeSession) => void] => [
      raw,
      (s) => s.failStream(new Error(raw)),
    ]),
    ["the stream ends", (s) => s.endStream()],
  ];
  for (const [raw, end] of stopEnds)
    it(`a death the stop could cause waits for it: ${raw}`, async () => {
      // With no stop the death shows: the case reaches a chat line.
      expect(await errorsAfter(end, false)).toBeGreaterThan(0);
      expect(await errorsAfter(end, true)).toBe(0);
    });
  for (const raw of OTHER_DEATHS)
    it(`any other death writes its line, stop or not: ${raw}`, async () => {
      expect(
        await errorsAfter((s) => s.failStream(new Error(raw)), true),
      ).toBeGreaterThan(0);
    });

  // The held lines are written from a timer, where a throw ends the server.
  it("a held line that fails to write does not stop the next one", async () => {
    const h = makeHarness([], {
      sinkThrowsAt: (e) => e.kind === "error",
    });
    const { info, session } = await working(h, "claude");
    const from = h.logs.length;
    session.failStream(new Error(DEATH));
    await waitUntil(() => !busy(h, info.id), "turn ended");
    await pastClearDelay(h);
    // The death writes two error lines; the first one's write threw.
    expect(
      linesFrom(h, from).filter((l) => l.startsWith("error: ")).length,
    ).toBe(1);
  });

  it("the wake keeps what the member needs: the background work the restart ended, and why a rejection was not a human's", async () => {
    const WORK = [
      { id: "b1", kind: "command" as const, label: "bun run safe-push" },
    ];
    const h1 = makeHarness();
    const { info, session } = await working(h1, "claude");
    session.push({ kind: "background_tasks", tasks: WORK });
    await waitUntil(
      () => h1.mgr.getAgent(info.id)?.backgroundTasks?.length === 1,
      "work running",
    );
    h1.stopping.value = true;
    session.push({ kind: "background_tasks", tasks: [] });
    session.failStream(new Error(DEATH));
    await waitUntil(() => !busy(h1, info.id), "turn cut");
    await pastClearDelay(h1);

    const h2 = await restart();
    // The Claude transcript shows the stop forged a rejection.
    const sessionId = loadAgents()
      .flatMap((r) => r.agents)
      .find((a) => a.id === info.id)!.lastSessionId!;
    const dir = claudeProjectDir(STATE_ROOT, {
      CLAUDE_CONFIG_DIR: claudeHome(),
    });
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({ interruptedByShutdown: true })}\n`,
    );
    await toFirstWakes(h2);
    await waitUntil(() => wakesTo(h2, info.id) === 1, "woken");
    await settle();

    const lines = linesFrom(h2);
    expect(lines).toContain(`system: ${RESUMED}`);
    expect(lines.filter((l) => l.includes(WORK[0].label)).length).toBe(1);
    expect(lines.filter((l) => l.includes(REJECTION)).length).toBe(1);
    for (const said of [AFTER_RESTART, IN_FLIGHT, INTERRUPTED])
      expect({ said, lines: lines.filter((l) => l.includes(said)) }).toEqual({
        said,
        lines: [],
      });
  });
});
