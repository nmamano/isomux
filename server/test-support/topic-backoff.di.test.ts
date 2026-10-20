// Topic generation. A failed one-shot: automatic triggers back off per model,
// the manual refresh does not, and a failed refresh keeps the old label. The
// lifecycle (task 1b8084fd): the topic is a label or null, a separate flag
// shows a running generation, and only an empty topic fills by itself.
import {
  afterEach,
  describe,
  expect,
  it,
  setSystemTime,
  spyOn,
} from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OfficeState } from "../../shared/office-state.ts";
import type { AgentBackendType, RoomWire } from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import type { AgentEvent } from "../internal-types.ts";
import { codexBackend } from "../backends/codex/adapter.ts";
import { isCodexAuthenticated } from "../backends/codex/native-bin.ts";
import { STATE_ROOT } from "../config.ts";
import {
  listAgentSessions,
  loadAgentHistory,
  saveAgentHistory,
  type PersistedAgent,
} from "../persistence.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";

const MINUTE = 60_000;
const START = new Date("2026-10-17T12:00:00Z").getTime();

afterEach(() => {
  setSystemTime();
  clearTestManagedOfficeEnv();
});

function room(id: string): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: false };
}

// setSystemTime freezes Date.now, so the deadline reads performance.now.
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check() && performance.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

// The one-shot is fire-and-forget; give a skipped trigger the same window a
// real one would need to reach the backend.
async function settle(): Promise<void> {
  await Bun.sleep(100);
}

// A one-shot reply the test settles by hand, to hold a generation open.
function deferred() {
  let resolve!: (label: string) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { reply: () => promise, resolve, reject };
}

// Each reply in `replies` answers one one-shot call in order: a string is the
// label, an Error is a failed call, a function runs and returns the reply.
async function harness(
  replies: (string | Error | (() => string | Promise<string>))[],
  opts: {
    agentType?: AgentBackendType;
    isAuthError?: (text: string) => boolean;
  } = {},
) {
  setSystemTime(START);
  let calls = 0;
  // One-shot calls whose reply has settled (answered or failed).
  let answered = 0;
  const fake = new FakeBackend({
    models: [
      { id: "slow", label: "Slow", supportedEfforts: [], isDefault: true },
      { id: "fast", label: "Fast", supportedEfforts: [] },
    ],
    oneShot: async () => {
      try {
        const reply = replies[calls++];
        if (reply === undefined) throw new Error("unexpected one-shot call");
        if (reply instanceof Error) throw reply;
        return typeof reply === "function" ? await reply() : reply;
      } finally {
        answered++;
      }
    },
    isAuthError: opts.isAuthError,
    session: {
      onSend: (_text, _attachments, session) =>
        session.completeTurn({ text: "ok" }),
    },
  });
  const roomId = `topic-${crypto.randomUUID()}`;
  const officeState = new OfficeState({ rooms: [room(roomId)] });
  const events: AgentEvent[] = [];
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState,
    initialRooms: [],
    findUser: () => ({ id: "user-a", role: "member" }),
    eventSink: (event) => events.push(event),
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    `Topic ${roomId}`,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    "slow",
    "high",
    "tester",
    opts.agentType ?? "opencode",
    undefined,
    "user-a",
  );
  const agentId = info!.id;
  const topic = () => mgr.getAgent(agentId)?.topic;
  // The flag as the office snapshot carries it to a client that connects now.
  const generating = () => officeState.getAgent(agentId)?.topicGenerating;
  // Waits until every topic call so far has its reply and the flag is down.
  const idle = () =>
    waitFor(() => answered === fake.oneShotCount && generating() !== true);
  // Sends one message and waits until any topic call it started has settled.
  const send = async (text: string) => {
    await mgr.sendMessage(agentId, text, "tester");
    await settle();
    await idle();
  };
  const refresh = async () => {
    const before = fake.oneShotCount;
    mgr.resetTopic(agentId);
    await waitFor(() => fake.oneShotCount > before);
    await idle();
  };
  // agent_updated changes for this agent, from index `from` of the sink.
  const changesSince = (from: number) =>
    events
      .slice(from)
      .flatMap((e) =>
        e.type === "agent_updated" && e.agentId === agentId ? [e.changes] : [],
      );
  return {
    mgr,
    fake,
    agentId,
    topic,
    generating,
    events,
    changesSince,
    send,
    refresh,
    idle,
    answered: () => answered,
  };
}

const timedOut = () => new Error("OpenCode one-shot prompt timed out.");

describe("topic generation backoff", () => {
  it("skips automatic tries until the wait ends, and doubles the wait", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fake, agentId, send } = await harness([
        timedOut(),
        timedOut(),
        timedOut(),
      ]);
      await send("first");
      expect(fake.oneShotCount).toBe(1);
      await send("second, same minute");
      expect(fake.oneShotCount).toBe(1);

      setSystemTime(START + 10 * MINUTE + 1);
      await send("after the first wait");
      expect(fake.oneShotCount).toBe(2);

      // The second failure waits 20 minutes, not 10.
      setSystemTime(START + 20 * MINUTE + 2);
      await send("10 minutes after the second failure");
      expect(fake.oneShotCount).toBe(2);
      setSystemTime(START + 30 * MINUTE + 2);
      await send("20 minutes after the second failure");
      expect(fake.oneShotCount).toBe(3);

      // One journal line per real attempt, none for a skipped one.
      const lines = errors.mock.calls.filter((call) =>
        call.some((arg) => String(arg).includes(agentId)),
      );
      expect(lines).toHaveLength(3);
    } finally {
      errors.mockRestore();
    }
  });

  it("restarts the wait from the base after a success", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { mgr, fake, agentId, topic, send } = await harness([
        timedOut(),
        "Label one",
        timedOut(),
        "Label two",
      ]);
      await send("first");
      setSystemTime(START + 10 * MINUTE + 1);
      await send("after the wait");
      expect(fake.oneShotCount).toBe(2);
      expect(topic()).toBe("Label one");

      // A new conversation has no topic, so its first message tries again.
      await mgr.newConversation(agentId);
      expect(topic()).toBeNull();
      await send("new conversation");
      expect(fake.oneShotCount).toBe(3);

      // Counted as a first failure: 10 minutes, not 20.
      setSystemTime(START + 20 * MINUTE + 2);
      await send("10 minutes later");
      expect(fake.oneShotCount).toBe(4);
      expect(topic()).toBe("Label two");
    } finally {
      errors.mockRestore();
    }
  });

  it("lets the manual refresh run during the wait", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fake, topic, send, refresh } = await harness([
        timedOut(),
        "Manual label",
      ]);
      await send("first");
      expect(fake.oneShotCount).toBe(1);
      // The wait is active: an automatic try in the same minute is skipped.
      await send("second, same minute");
      expect(fake.oneShotCount).toBe(1);
      await refresh();
      expect(fake.oneShotCount).toBe(2);
      expect(topic()).toBe("Manual label");
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the earlier topic when a refresh fails", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { topic, generating, send, refresh } = await harness([
        "Earlier label",
        timedOut(),
      ]);
      await send("first");
      expect(topic()).toBe("Earlier label");
      await refresh();
      expect(topic()).toBe("Earlier label");
      expect(generating()).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it("ignores the wait after a model change", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { mgr, fake, agentId, topic, send } = await harness([
        timedOut(),
        "Fast label",
      ]);
      await send("first");
      expect(fake.oneShotCount).toBe(1);
      await mgr.editAgent(agentId, { modelFamily: "fast" });
      expect(mgr.getAgent(agentId)?.modelFamily).toBe("fast");
      await send("second, same minute");
      expect(fake.oneShotCount).toBe(2);
      expect(topic()).toBe("Fast label");
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the earlier topic and starts no wait on a signed-out notice", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const codexHome = join(STATE_ROOT, `topic-codex-${crypto.randomUUID()}`);
      mkdirSync(codexHome, { recursive: true });
      const authFile = join(codexHome, "auth.json");
      writeFileSync(authFile, "{}");
      setTestManagedOfficeEnv({ CODEX_HOME: codexHome, OPENAI_API_KEY: "" });
      const notice = "401 Unauthorized";
      expect(codexBackend.detectAuthError(notice)).toBe(true);
      const { mgr, fake, agentId, topic, generating, send, refresh } =
        await harness(
          [
            "Earlier label",
            () => {
              // Signed out while the call ran: the reply is the auth notice.
              rmSync(authFile);
              return notice;
            },
            "Fresh label",
          ],
          {
            agentType: "codex",
            isAuthError: (text) => codexBackend.detectAuthError(text),
          },
        );
      await send("first");
      expect(topic()).toBe("Earlier label");

      await refresh();
      expect(fake.oneShotCount).toBe(2);
      expect(isCodexAuthenticated(mgr.buildEnvForUserId("user-a"))).toBe(false);
      expect(topic()).toBe("Earlier label");
      expect(generating()).toBe(false);

      // Signed in again, a new conversation labels at once: no wait.
      writeFileSync(authFile, "{}");
      await mgr.newConversation(agentId);
      expect(topic()).toBeNull();
      await send("new conversation");
      expect(fake.oneShotCount).toBe(3);
      expect(topic()).toBe("Fresh label");
      expect(
        errors.mock.calls.filter((call) =>
          call.some((arg) => String(arg).includes(agentId)),
        ),
      ).toHaveLength(0);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("topic lifecycle (task 1b8084fd)", () => {
  it("keeps the label while a refresh runs and shows the run with a flag", async () => {
    const later = deferred();
    const {
      fake,
      topic,
      generating,
      events,
      changesSince,
      send,
      mgr,
      agentId,
      idle,
    } = await harness(["Earlier label", later.reply]);
    await send("first");
    expect(topic()).toBe("Earlier label");

    const from = events.length;
    mgr.resetTopic(agentId);
    await waitFor(() => fake.oneShotCount === 2);
    // The old label stays; the snapshot a new client reads says it runs.
    expect(topic()).toBe("Earlier label");
    expect(generating()).toBe(true);

    later.resolve("Later label");
    await idle();
    expect(topic()).toBe("Later label");
    expect(generating()).toBe(false);
    // Clients saw the flag go up and down, and no topic but the new label.
    const changes = changesSince(from);
    expect(
      changes.map((c) => c.topicGenerating).filter((g) => g !== undefined),
    ).toEqual([true, false]);
    expect(changes.flatMap((c) => ("topic" in c ? [c.topic] : []))).toEqual([
      "Later label",
    ]);
  });

  it("lets a refresh run after a typed topic overtook a generation", async () => {
    const first = deferred();
    const { fake, topic, mgr, agentId, refresh, answered } = await harness([
      first.reply,
      "Fresh label",
    ]);
    await mgr.sendMessage(agentId, "first", "tester");
    await waitFor(() => fake.oneShotCount === 1);
    mgr.setTopic(agentId, "Typed label");
    first.resolve("Late label");
    await waitFor(() => answered() === 1);
    await settle();
    expect(topic()).toBe("Typed label");

    // Before the fix the overtaken call left the generator marked busy, so
    // no refresh or automatic fill ever ran again in this conversation.
    await refresh();
    expect(fake.oneShotCount).toBe(2);
    expect(topic()).toBe("Fresh label");
  });

  it("keeps the flag of a refresh that started while an overtaken call was out", async () => {
    const first = deferred();
    const second = deferred();
    const { fake, topic, generating, mgr, agentId, idle, answered } =
      await harness([first.reply, second.reply]);
    await mgr.sendMessage(agentId, "first", "tester");
    await waitFor(() => fake.oneShotCount === 1);
    expect(generating()).toBe(true);

    mgr.setTopic(agentId, "Typed label");
    expect(topic()).toBe("Typed label");
    expect(generating()).toBe(false);

    // The refresh starts while the overtaken call is still out.
    mgr.resetTopic(agentId);
    await waitFor(() => fake.oneShotCount === 2);
    expect(generating()).toBe(true);

    // The overtaken call ends: its label is dropped and it leaves the
    // refresh's flag alone.
    first.resolve("Late label");
    await waitFor(() => answered() === 1);
    await settle();
    expect(topic()).toBe("Typed label");
    expect(generating()).toBe(true);

    second.resolve("Fresh label");
    await idle();
    expect(topic()).toBe("Fresh label");
    expect(generating()).toBe(false);
  });

  it("keeps a label as the chat grows; only an empty topic fills by itself", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Any call after the first answers "unexpected one-shot call".
      const { fake, topic, mgr, agentId, send } = await harness([
        "First label",
      ]);
      await send("first");
      expect(fake.oneShotCount).toBe(1);
      expect(topic()).toBe("First label");

      // Each message adds a user entry and a reply: 15 messages are 30
      // entries, past the old 20-entry refresh threshold.
      for (let i = 0; i < 15; i++)
        await mgr.sendMessage(agentId, `generated ${i}`, "tester");
      await send("generated last");
      expect(fake.oneShotCount).toBe(1);
      expect(topic()).toBe("First label");

      mgr.setTopic(agentId, "Typed label");
      for (let i = 0; i < 15; i++)
        await mgr.sendMessage(agentId, `typed ${i}`, "tester");
      await send("typed last");
      expect(fake.oneShotCount).toBe(1);
      expect(topic()).toBe("Typed label");
    } finally {
      errors.mockRestore();
    }
  });

  it("clears the topic on a blank edit, and the next message fills it again", async () => {
    const { fake, topic, mgr, agentId, send } = await harness([
      "First label",
      "Second label",
    ]);
    await send("first");
    expect(topic()).toBe("First label");
    const sessionId = mgr.getCurrentSessionId(agentId);
    expect(sessionId).toBeTruthy();
    const stored = () =>
      listAgentSessions(agentId).find((s) => s.sessionId === sessionId)?.topic;

    mgr.setTopic(agentId, "  Spaced label  ");
    expect(topic()).toBe("Spaced label");
    expect(stored()).toBe("Spaced label");

    mgr.setTopic(agentId, "   ");
    expect(topic()).toBeNull();
    expect(stored()).toBeNull();

    await send("second");
    expect(fake.oneShotCount).toBe(2);
    expect(topic()).toBe("Second label");
  });

  it("keeps the topic when a refresh finds no user message", async () => {
    const { fake, topic, generating, mgr, agentId } = await harness([
      "Unused label",
    ]);
    mgr.setTopic(agentId, "Typed label");
    mgr.resetTopic(agentId);
    await settle();
    expect(fake.oneShotCount).toBe(0);
    expect(topic()).toBe("Typed label");
    expect(generating()).toBe(false);
  });

  it("reads a stored placeholder or blank topic as no topic", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const persisted = (id: string, topic: string): PersistedAgent =>
      ({
        id,
        name: id,
        desk: 0,
        cwd: STATE_ROOT,
        outfit: {
          hat: "none",
          color: "#000000",
          hair: "#000000",
          hairStyle: "short",
          skin: "#ffffff",
          beard: "none",
          accessory: null,
        },
        permissionMode: "default",
        modelFamily: "slow",
        effort: "high",
        agentType: "opencode",
        lastSessionId: null,
        topic,
        customInstructions: null,
        userId: null,
        username: null,
      }) as unknown as PersistedAgent;
    const roomId = `topic-restore-${tag}`;
    const restored = [
      persisted(`dots-${tag}`, "..."),
      { ...persisted(`blank-${tag}`, "  "), desk: 1 },
      { ...persisted(`kept-${tag}`, "Real label"), desk: 2 },
    ];

    // A killed agent from before the change, and its revive record.
    const killedId = `killed-${tag}`;
    saveAgentHistory({
      ...loadAgentHistory(),
      [killedId]: {
        name: killedId,
        lastRoomId: roomId,
        lastRoomName: roomId,
        killedAt: START,
        topic: "...",
      },
    });

    // A session saved while a generation ran, one saved blank, one labelled.
    const sessionsAgent = `sessions-${tag}`;
    const logDir = join(STATE_ROOT, "logs", sessionsAgent);
    mkdirSync(logDir, { recursive: true });
    for (const sid of ["dots", "blank", "kept"])
      writeFileSync(join(logDir, `${sid}.jsonl`), "");
    writeFileSync(
      join(logDir, "sessions.json"),
      JSON.stringify({
        dots: { topic: "...", lastModified: 3, topicMessageCount: 4 },
        blank: { topic: "", lastModified: 2 },
        kept: { topic: "Real label", lastModified: 1 },
      }),
    );

    const fake = new FakeBackend({});
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: [room(roomId)] }),
      initialRooms: [
        { id: roomId, name: roomId, prompt: null, agents: restored },
      ],
    });
    await mgr.restoreAgents();
    expect(mgr.getAgent(`dots-${tag}`)?.topic).toBeNull();
    expect(mgr.getAgent(`blank-${tag}`)?.topic).toBeNull();
    expect(mgr.getAgent(`kept-${tag}`)?.topic).toBe("Real label");
    for (const a of restored)
      expect(mgr.getAgent(a.id)?.topicGenerating).toBe(false);

    const killed = mgr.getKilledAgentSummaries().find((k) => k.id === killedId);
    expect(killed).toBeDefined();
    expect(killed?.topic).toBeNull();

    expect(
      Object.fromEntries(
        listAgentSessions(sessionsAgent).map((s) => [s.sessionId, s.topic]),
      ),
    ).toEqual({ dots: null, blank: null, kept: "Real label" });
  });
});
