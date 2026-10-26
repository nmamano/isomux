// Wake after a server restart (server/restart-wake.ts). Seam: the DI manager
// (createAgentManager + FakeBackend) with an injected clock for the clear
// delay and the spread wakes, and an injected serverStopping(). A restart is a
// second manager on the same state root, built from agents.json the way the
// office boots (loadAgents()); the first one is left as it was, as a crash
// leaves it. The record is read from disk, where the next boot reads it.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
  opts: { manualSend?: boolean } = {},
): Harness {
  const fake = new FakeBackend(
    opts.manualSend ? { session: { manualSend: true } } : {},
  );
  const clock = fakeClock();
  const logs: LogEntry[] = [];
  const stopping = { value: false };
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type === "log_entry" && ev.entry) logs.push(ev.entry);
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms,
    eventSink: sink,
    restartWakeClock: clock,
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

// turns-in-flight.json as the next boot reads it.
const RECORD_FILE = join(STATE_ROOT, "turns-in-flight.json");
type DiskRecord = Record<string, { since: number; restartWake?: true }>;
const onDisk = (): DiskRecord =>
  existsSync(RECORD_FILE)
    ? (JSON.parse(readFileSync(RECORD_FILE, "utf-8")) as DiskRecord)
    : {};
const seedRecord = (record: DiskRecord) =>
  writeFileSync(RECORD_FILE, JSON.stringify(record));

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
