// DI tests for the restart rule of the secrets design (section 2.6, appendix
// D): a change of the set of secrets in a scope releases the processes of
// that scope's agents, so their next turn starts a new process with the
// current environment and resumes the same conversation. FakeBackend only.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { BackgroundTask, RoomWire } from "../../shared/types.ts";
import { english } from "../i18n.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { setSecretEnvironmentProvider } from "../env-loader.ts";
import {
  getSessionClaudeConfigDir,
  setSessionClaudeConfigDir,
} from "../persistence.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

const ROOMS: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];

const claudeHome = () => join(STATE_ROOT, "claude-home-secrets-restart");

// Every send completes its turn, except "hold", which stays busy until the
// test completes it.
function makeFake(): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (text, _a, s) => {
        if (!text.includes("hold")) s.completeTurn({ text: "ok" });
      },
    },
  });
}

function makeManager(fake: FakeBackend) {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: ROOMS }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  return mgr;
}

type Manager = ReturnType<typeof makeManager>;

function live(mgr: Manager, id: string): boolean {
  const agent = mgr.getAgent(id);
  return (
    mgr.getCurrentSessionId(id) !== null &&
    agent?.dormant !== true &&
    (agent?.state === "idle" || agent?.state === "waiting_for_response")
  );
}

function dormant(mgr: Manager, id: string): boolean {
  return mgr.getAgent(id)?.dormant === true;
}

function send(mgr: Manager, id: string, text: string) {
  const result = mgr.enqueueMessage(id, {
    sender: { kind: "user", username: "tester" },
    text,
  });
  if (!result.ok) throw new Error("enqueue failed");
}

// The on-disk transcript the Claude resume check looks for.
function seedSession(mgr: Manager, id: string) {
  const sessionId = mgr.getCurrentSessionId(id)!;
  const dir = claudeProjectDir(STATE_ROOT, { CLAUDE_CONFIG_DIR: claudeHome() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "");
}

async function spawnLive(mgr: Manager, name: string, userId: string | null) {
  const info = await mgr.spawn(
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
    "claude",
    undefined,
    userId,
  );
  if (!info) throw new Error("spawn failed");
  send(mgr, info.id, "wake");
  await waitUntil(() => live(mgr, info.id), `${name} live`);
  seedSession(mgr, info.id);
  return info.id;
}

async function wake(mgr: Manager, id: string) {
  send(mgr, id, "again");
  await waitUntil(() => live(mgr, id), "woke");
  seedSession(mgr, id);
}

afterEach(() => clearTestManagedOfficeEnv());

describe("which agents a secrets change reaches", () => {
  it("a member change releases only that member's agents; an office change and a port change release every member's", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const alice = await spawnLive(mgr, "Alice", "u-alice");
    const bob = await spawnLive(mgr, "Bob", "u-bob");
    const unowned = await spawnLive(mgr, "Nobody", null);

    mgr.envChanged([{ kind: "user", userId: "u-alice" }]);
    await waitUntil(() => dormant(mgr, alice), "alice released");
    expect(dormant(mgr, bob)).toBe(false);
    expect(dormant(mgr, unowned)).toBe(false);

    await wake(mgr, alice);
    mgr.envChanged([{ kind: "office" }]);
    await waitUntil(
      () => [alice, bob, unowned].every((id) => dormant(mgr, id)),
      "office change released all",
    );

    for (const id of [alice, bob, unowned]) await wake(mgr, id);
    mgr.envChanged("all");
    await waitUntil(
      () => [alice, bob, unowned].every((id) => dormant(mgr, id)),
      "port change released all",
    );
  });
});

describe("when the release happens", () => {
  it("an idle agent is released at once and resumes the same conversation, and the agent is told", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "Idle", "u-alice");
    const sessionId = mgr.getCurrentSessionId(id);
    const resumes = fake.resumeSessionCount;
    const firstSession = fake.sessionForAgent(id)!;

    // The office gets its first secret: from now on, environments carry its
    // placeholder and the proxy.
    const restore = setSecretEnvironmentProvider(() => ({
      office: { OFFICE_KEY: "office-placeholder-0001" },
      member: {},
      fixed: { HTTPS_PROXY: "http://127.0.0.1:9" },
      gitCredentials: [],
      revision: "first-secret",
    }));
    try {
      mgr.envChanged([{ kind: "office" }]);
      expect(dormant(mgr, id)).toBe(true);
      send(mgr, id, "after");
      await waitUntil(() => live(mgr, id), "woke");
    } finally {
      setSecretEnvironmentProvider(restore);
    }
    const newSession = fake.sessionForAgent(id)!;
    expect(newSession).not.toBe(firstSession);
    expect(newSession.opts.env?.OFFICE_KEY).toBe("office-placeholder-0001");
    expect(newSession.opts.env?.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(firstSession.opts.env?.OFFICE_KEY).toBeUndefined();

    expect(fake.resumeSessionCount).toBe(resumes + 1);
    expect(mgr.getCurrentSessionId(id)).toBe(sessionId);
    const wakeText = english.t("systemEntries.wake.env");
    expect(
      mgr.getAgentLogs(id).some((e) => String(e.content ?? "") === wakeText),
    ).toBe(true);
    // The note reached the agent with the message.
    expect(fake.sessionForAgent(id)!.sent.at(-1)!.text).toContain(wakeText);
  });

  it("a busy agent is released when its turn ends, with nothing queued", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "BusyAlone", "u-alice");
    send(mgr, id, "hold");
    await waitUntil(
      () => fake.sessionForAgent(id)!.sent.some((m) => m.text.includes("hold")),
      "busy",
    );
    mgr.envChanged([{ kind: "user", userId: "u-alice" }]);
    expect(dormant(mgr, id)).toBe(false);
    fake.sessionForAgent(id)!.completeTurn({ text: "done" });
    await waitUntil(() => dormant(mgr, id), "released at turn end");
  });

  it("a busy agent is released when its turn ends, and a message queued meanwhile runs on a new process", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "Busy", "u-alice");
    send(mgr, id, "hold");
    await waitUntil(
      () => fake.sessionForAgent(id)!.sent.some((m) => m.text.includes("hold")),
      "busy",
    );
    const busySession = fake.sessionForAgent(id)!;

    mgr.envChanged([{ kind: "office" }]);
    // Busy: not released yet.
    expect(dormant(mgr, id)).toBe(false);
    send(mgr, id, "queued-next");

    busySession.completeTurn({ text: "done" });
    await waitUntil(
      () =>
        fake.sessionForAgent(id) !== busySession &&
        fake
          .sessionForAgent(id)!
          .sent.some((m) => m.text.includes("queued-next")),
      "queued message on a new process",
    );
    // No turn started on the old process after the change.
    expect(busySession.sent.some((m) => m.text.includes("queued-next"))).toBe(
      false,
    );
  });
});

// Background work (task 28093a03): a change does not end it while the agent
// is idle. The mark waits for the next turn, which starts on a new process and
// tells the agent which work the release ended, or for the idle release at the
// background cap. A background list that clears releases nothing by itself:
// the engine's own turn with the result runs right then.
describe("an agent with background work", () => {
  const TASKS: BackgroundTask[] = [
    { id: "b1", kind: "command", label: "npm run build" },
    { id: "a1", kind: "agent", label: "Review the diff" },
  ];

  async function setBackground(
    mgr: Manager,
    fake: FakeBackend,
    id: string,
    tasks: BackgroundTask[],
  ) {
    fake.sessionForAgent(id)!.push({ kind: "background_tasks", tasks });
    await waitUntil(
      () => (mgr.getAgent(id)?.backgroundTasks?.length ?? 0) === tasks.length,
      "background list set",
    );
  }

  // Sends one message, waits for its turn to end, and returns the session it
  // ran on and its text.
  async function turn(
    mgr: Manager,
    fake: FakeBackend,
    id: string,
    text: string,
    how: "queued" | "direct" = "queued",
  ) {
    if (how === "queued") send(mgr, id, text);
    else void mgr.sendMessage(id, text, "tester");
    const ranOn = () =>
      fake.sessions.find(
        (s) =>
          s.opts.agentId === id && s.sent.some((m) => m.text.includes(text)),
      );
    await waitUntil(
      () =>
        !!ranOn() &&
        ["idle", "waiting_for_response"].includes(mgr.getAgent(id)!.state),
      `turn "${text}" ran`,
    );
    const session = ranOn()!;
    return {
      session,
      text: session.sent.find((m) => m.text.includes(text))!.text,
    };
  }

  const envLine = english.t("systemEntries.wake.env");
  const namesEnded = (text: string) =>
    TASKS.every((task) => text.includes(task.label));
  const namesAnyEnded = (text: string) =>
    TASKS.some((task) => text.includes(task.label));

  it("an idle agent keeps its process; the list clearing does not release it; the next turn runs on a new process, told of the change only", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "Builder", "u-alice");
    await setBackground(mgr, fake, id, TASKS);
    const first = fake.sessionForAgent(id)!;

    mgr.envChanged([{ kind: "user", userId: "u-alice" }]);
    await sleep(100);
    expect(dormant(mgr, id)).toBe(false);
    expect(first.closed).toBe(false);

    // The work ends. The engine starts its own turn with the result now, so
    // the process stays.
    first.push({ kind: "background_tasks", tasks: [] });
    await waitUntil(
      () => (mgr.getAgent(id)?.backgroundTasks ?? null) === null,
      "background list cleared",
    );
    await sleep(100);
    expect(dormant(mgr, id)).toBe(false);
    expect(first.closed).toBe(false);

    // The next turn: the mark still holds, so it starts a new process.
    const next = await turn(mgr, fake, id, "after-build");
    expect(next.session === first).toBe(false);
    expect(first.closed).toBe(true);
    expect(first.sent.some((m) => m.text.includes("after-build"))).toBe(false);
    expect(next.text).toContain(envLine);
    expect(namesAnyEnded(next.text)).toBe(false);
  });

  it("a busy agent whose turn starts background work keeps its process when the turn ends", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "BusyBuilder", "u-alice");
    send(mgr, id, "hold");
    await waitUntil(
      () => fake.sessionForAgent(id)!.sent.some((m) => m.text.includes("hold")),
      "busy",
    );
    const first = fake.sessionForAgent(id)!;
    mgr.envChanged([{ kind: "user", userId: "u-alice" }]);
    await setBackground(mgr, fake, id, TASKS);
    first.completeTurn({ text: "started the build" });
    await waitUntil(
      () => mgr.getAgent(id)?.state === "waiting_for_response",
      "turn ended",
    );
    await sleep(100);
    expect(dormant(mgr, id)).toBe(false);
    expect(first.closed).toBe(false);

    // The mark held: the work ends, and the next turn starts a new process.
    first.push({ kind: "background_tasks", tasks: [] });
    await waitUntil(
      () => (mgr.getAgent(id)?.backgroundTasks ?? null) === null,
      "background list cleared",
    );
    const next = await turn(mgr, fake, id, "after-build");
    expect(next.session === first).toBe(false);
    expect(next.text).toContain(envLine);
  });

  // Both turn starts: a queued message (the flush) and a member's message
  // (sendMessage).
  for (const how of ["queued", "direct"] as const) {
    it(`a turn that starts while the work runs starts on a new process, and the agent is told the change and the work it ended: ${how}`, async () => {
      setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
      const fake = makeFake();
      const mgr = makeManager(fake);
      const id = await spawnLive(mgr, "Interrupted", "u-alice");
      await setBackground(mgr, fake, id, TASKS);
      const first = fake.sessionForAgent(id)!;
      mgr.envChanged([{ kind: "office" }]);

      const next = await turn(mgr, fake, id, "secret saved", how);
      expect(next.session === first).toBe(false);
      expect(first.closed).toBe(true);
      expect(first.sent.some((m) => m.text.includes("secret saved"))).toBe(
        false,
      );
      expect(next.text).toContain(envLine);
      expect(namesEnded(next.text)).toBe(true);
      // The member's transcript says it too.
      const logs = mgr
        .getAgentLogs(id)
        .map((e) => String(e.content ?? ""))
        .join("\n");
      expect(namesEnded(logs)).toBe(true);
    });
  }

  it("the idle release at the background cap releases a marked agent once: the wake names the change and the ended work, and the next turn stays on that process", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "Capped", "u-alice");
    await setBackground(mgr, fake, id, TASKS);
    const first = fake.sessionForAgent(id)!;
    mgr.envChanged([{ kind: "user", userId: "u-alice" }]);
    await sleep(100);
    expect(dormant(mgr, id)).toBe(false);

    // Under the cap: held. At the cap: released.
    expect(await mgr.sweepIdleAgents(0, 60_000)).toBe(0);
    expect(first.closed).toBe(false);
    expect(await mgr.sweepIdleAgents(0, 0)).toBe(1);
    expect(dormant(mgr, id)).toBe(true);

    const woke = await turn(mgr, fake, id, "wake-up-turn");
    expect(woke.session === first).toBe(false);
    expect(woke.text).toContain(envLine);
    expect(namesEnded(woke.text)).toBe(true);
    seedSession(mgr, id);

    // The new process has the current environment: no second release, at
    // the end of the wake turn or at the next turn.
    await sleep(50);
    expect(woke.session.closed).toBe(false);
    const again = await turn(mgr, fake, id, "again");
    expect(again.session === woke.session).toBe(true);
    expect(woke.session.closed).toBe(false);
    expect(again.text).not.toContain(envLine);
  });
});

// A removed member's Claude sign-in is deleted (task 548d607b): a process of
// another member's agent on a session pinned to that member's home keeps the
// token in memory and could write it back, so it is released like an
// environment change.
describe("a deleted Claude sign-in", () => {
  it("releases the agents whose session is pinned to its directory, a busy one at the end of its turn, and no other", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const removedHome = join(STATE_ROOT, "provider-homes", "u-mia", "claude");
    const pinned = await spawnLive(mgr, "Pinned", "u-bob");
    const busy = await spawnLive(mgr, "PinnedBusy", "u-bob");
    const other = await spawnLive(mgr, "Other", "u-bob");
    // Pinned there because the transcript is there.
    const transcripts = claudeProjectDir(STATE_ROOT, {
      CLAUDE_CONFIG_DIR: removedHome,
    });
    mkdirSync(transcripts, { recursive: true });
    for (const id of [pinned, busy]) {
      const sessionId = mgr.getCurrentSessionId(id)!;
      writeFileSync(join(transcripts, `${sessionId}.jsonl`), "");
      setSessionClaudeConfigDir(id, sessionId, removedHome);
    }
    // The condition: two sessions on the removed home, one elsewhere.
    const pinOf = (id: string) =>
      getSessionClaudeConfigDir(id, mgr.getCurrentSessionId(id)!);
    expect([pinOf(pinned), pinOf(busy)]).toEqual([removedHome, removedHome]);
    expect(pinOf(other)).not.toBe(removedHome);
    send(mgr, busy, "hold");
    await waitUntil(
      () =>
        fake.sessionForAgent(busy)!.sent.some((m) => m.text.includes("hold")),
      "busy",
    );

    mgr.releaseClaudeRoot(removedHome);
    await waitUntil(() => dormant(mgr, pinned), "pinned released");
    expect(dormant(mgr, busy)).toBe(false);
    fake.sessionForAgent(busy)!.completeTurn({ text: "done" });
    await waitUntil(() => dormant(mgr, busy), "busy released at turn end");
    expect(dormant(mgr, other)).toBe(false);
  });
});
