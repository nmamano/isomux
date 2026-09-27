// Steer delivery without a phantom rejection (tasks 0a248523, 7529b23b;
// internal-docs/steer-delivery-design.md).
//
// Before: an agent's "steer":true at a busy receiver aborted the turn. The
// Claude CLI then reported the cut tool call as "rejected by the user", and the
// receiver stopped and asked the member for instructions.
//
// Now, on a backend with tool-boundary delivery (Claude), the steer waits for
// the running tool batch and the PostToolBatch hook hands the queue to the
// model inside the turn. On every path that still aborts, the flush names the
// cause of the interruption.
//
// Seam: the DI manager (createAgentManager + FakeBackend), as in
// edit-attachments.test.ts. FakeSession.toolBoundary() plays the SDK hook by
// calling the callback the manager put in the session options. Zero LLM calls.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import {
  loadLog,
  loadMessageQueuesRaw,
  loadSessionsMap,
} from "../persistence.ts";
import {
  AGENT_INTERRUPT_NOTE,
  MEMBER_INTERRUPT_NOTE,
  TOOL_BOUNDARY_NOTE,
  createAgentManager,
} from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import {
  formatAttachmentLines,
  resolveAttachmentNotices,
} from "../attachment-prompt.ts";
import {
  FakeBackend,
  type FakeBackendConfig,
  type FakeSession,
} from "./fake-backend.ts";
import type { EventHandler } from "../internal-types.ts";
import type {
  AgentInfo,
  Attachment,
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
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

const ATTACHMENT: Attachment = {
  filename: "notes_1.txt",
  originalName: "notes.txt",
  mediaType: "text/plain",
  size: 12,
};

// Every send parks its turn (busy, no turn_completed) until the test calls
// completeTurn(), so a test holds the receiver mid-turn as long as it needs.
function fakeBackend(cfg: FakeBackendConfig = {}): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
    ...cfg,
  });
}

function makeManager(fake: FakeBackend) {
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
  return { mgr, logs };
}

type Manager = ReturnType<typeof makeManager>["mgr"];

async function spawn(
  mgr: Manager,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  const info = await mgr.spawn(
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

function stateOf(mgr: Manager, id: string): string | undefined {
  return mgr.getAgent(id)?.state;
}

function visibleQueue(mgr: Manager, id: string): QueuedMessage[] {
  return mgr.getAllAgents().find((a) => a.id === id)?.queue ?? [];
}

function persistedQueue(id: string): unknown[] {
  const rec = loadMessageQueuesRaw()[id] as { queue?: unknown[] } | undefined;
  return rec?.queue ?? [];
}

// Start a turn and wait until the receiver is running it.
async function startTurn(
  mgr: Manager,
  fake: FakeBackend,
  id: string,
  text = "kickoff",
): Promise<FakeSession> {
  void mgr.sendMessage(id, text);
  await waitUntil(
    () =>
      stateOf(mgr, id) === "thinking" &&
      !!fake.sessionForAgent(id)?.sent.some((m) => m.text.includes(text)),
    2000,
    `turn "${text}" running`,
  );
  return fake.sessionForAgent(id)!;
}

function steer(mgr: Manager, id: string, text: string, extra = {}) {
  return mgr.enqueueMessage(id, { sender: SENDER, text, ...extra }, {
    steer: true,
  });
}

// Everything any session of this agent received, in order.
function allSent(fake: FakeBackend, id: string): string[] {
  return fake.sessions
    .filter((s) => s.opts.agentId === id)
    .flatMap((s) => s.sent.map((m) => m.text));
}

describe("steer at a backend with tool-boundary delivery", () => {
  it("waits for the tool batch, then delivers inside the turn without aborting", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr, logs } = makeManager(fake);
    const info = await spawn(mgr);
    const session = await startTurn(mgr, fake, info.id);

    const r = steer(mgr, info.id, "urgent");
    expect(r).toMatchObject({ ok: true, queued: false, steered: true });
    expect("steerDeclined" in r).toBe(false);
    // Nothing was cut: same session, no abort, no interruption line.
    expect(session.abortCount).toBe(0);
    expect(session.closed).toBe(false);
    expect(fake.createSessionCount).toBe(1);
    expect(logs.some((e) => e.kind === "system" && /interrupt/i.test(e.content))).toBe(false);
    expect(visibleQueue(mgr, info.id).map((m) => m.text)).toEqual(["urgent"]);

    const text = session.toolBoundary();
    expect(text).not.toBeNull();
    expect(text!.startsWith(TOOL_BOUNDARY_NOTE)).toBe(true);
    expect(text).toContain("urgent");
    expect(text).toContain("agent-sender");

    // Logged at delivery, gone from the visible queue, still durable on disk
    // until the turn completes.
    const delivered = logs.filter(
      (e) => e.kind === "user_message" && e.content === "urgent",
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].metadata?.delivery).toBe("tool_boundary");
    expect(delivered[0].metadata?.sender_agent_id).toBe("agent-sender");
    expect(visibleQueue(mgr, info.id)).toEqual([]);
    expect(persistedQueue(info.id)).toHaveLength(1);

    // A second boundary in the same turn has nothing new to deliver.
    expect(session.toolBoundary()).toBeNull();

    session.completeTurn();
    await waitUntil(
      () => stateOf(mgr, info.id) === "waiting_for_response",
      2000,
      "idle",
    );
    await sleep(100);
    // Drained at turn_completed: no second delivery through the flush.
    expect(allSent(fake, info.id).filter((t) => t.includes("urgent"))).toEqual([]);
    expect(persistedQueue(info.id)).toEqual([]);
  });

  it("delivers through the turn-end flush when no tool boundary comes", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr, logs } = makeManager(fake);
    const info = await spawn(mgr);
    const session = await startTurn(mgr, fake, info.id);

    expect(steer(mgr, info.id, "urgent")).toMatchObject({ steered: true });
    session.completeTurn();
    await waitUntil(
      () => session.sent.some((m) => m.text.includes("urgent")),
      2000,
      "flushed",
    );
    const entry = logs.find(
      (e) => e.kind === "user_message" && e.content === "urgent",
    );
    expect(entry?.metadata?.delivery).toBeUndefined();
  });

  it("leaves a queue holding a member message to the turn-end flush", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const session = await startTurn(mgr, fake, info.id);

    void mgr.sendMessage(info.id, "from the member");
    await waitUntil(
      () => visibleQueue(mgr, info.id).length === 1,
      2000,
      "member message queued",
    );
    expect(steer(mgr, info.id, "urgent")).toMatchObject({ steered: true });
    expect(session.toolBoundary()).toBeNull();
    expect(visibleQueue(mgr, info.id)).toHaveLength(2);

    session.completeTurn();
    await waitUntil(
      () =>
        session.sent.some(
          (m) => m.text.includes("from the member") && m.text.includes("urgent"),
        ),
      2000,
      "both flushed together",
    );
  });

  it("carries attachments as the same path notices a backend send adds", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const dir = join(STATE_ROOT, "logs", info.id, "files");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ATTACHMENT.filename), "hello notes\n");
    const session = await startTurn(mgr, fake, info.id);

    steer(mgr, info.id, "see attached", { attachments: [ATTACHMENT] });
    const text = session.toolBoundary();
    const [notice] = formatAttachmentLines(
      resolveAttachmentNotices(info.id, [ATTACHMENT]),
    );
    expect(notice).toBeDefined();
    expect(text).toContain(notice);
  });

  it("a cancelled steer leaves no steer behind for a later plain message", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const session = await startTurn(mgr, fake, info.id);

    const r = steer(mgr, info.id, "never mind");
    expect(r.ok && r.messageId).toBeTruthy();
    expect(mgr.cancelQueued(info.id, (r as { messageId: string }).messageId)).toBe(true);
    mgr.enqueueMessage(info.id, { sender: SENDER, text: "plain" });
    expect(session.toolBoundary()).toBeNull();
  });

  it("a delivered item can no longer be cancelled", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const session = await startTurn(mgr, fake, info.id);

    const r = steer(mgr, info.id, "urgent") as { messageId: string };
    expect(session.toolBoundary()).not.toBeNull();
    expect(mgr.cancelQueued(info.id, r.messageId)).toBe(false);
  });

  it("a hook still firing in a replaced session claims nothing", async () => {
    // Codex agent type: the slow-path abort reinstalls a session, and Codex
    // fresh-starts instead of resuming the fake session id.
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr, "codex");
    const oldSession = await startTurn(mgr, fake, info.id);
    await mgr.abort(info.id);
    await waitUntil(
      () =>
        fake.sessionForAgent(info.id) !== oldSession &&
        stateOf(mgr, info.id) === "waiting_for_response",
      3000,
      "replaced",
    );
    const newSession = await startTurn(mgr, fake, info.id, "second turn");

    steer(mgr, info.id, "urgent");
    expect(oldSession.toolBoundary()).toBeNull();
    expect(visibleQueue(mgr, info.id)).toHaveLength(1);
    expect(newSession.toolBoundary()).toContain("urgent");
  });

  it("a claim whose session ends before turn_completed is delivered again", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr, "codex");
    const session = await startTurn(mgr, fake, info.id);

    steer(mgr, info.id, "urgent");
    expect(session.toolBoundary()).toContain("urgent");
    // A member Stop replaces the session before this turn completes.
    await mgr.abort(info.id);
    // At-least-once: the replacement session receives it through the flush.
    await waitUntil(
      () =>
        fake.sessionForAgent(info.id) !== session &&
        fake.sessionForAgent(info.id)!.sent.some((m) => m.text.includes("urgent")),
      3000,
      "redelivered",
    );
  });

  it("boundary steers interrupt nothing, so the rate limit neither counts nor refuses them", async () => {
    const fake = fakeBackend({ toolBoundaryDelivery: true });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    await startTurn(mgr, fake, info.id);

    const outcomes = [1, 2, 3, 4, 5].map((i) => steer(mgr, info.id, `s${i}`));
    for (const r of outcomes) expect(r).toMatchObject({ steered: true });
  });
});

describe("paths that still abort name the cause", () => {
  it("an agent steer at a backend without boundary delivery gets the agent note", async () => {
    const fake = fakeBackend();
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr, "codex");
    const session = await startTurn(mgr, fake, info.id);

    expect(steer(mgr, info.id, "urgent")).toMatchObject({ steered: true });
    await waitUntil(
      () => allSent(fake, info.id).some((t) => t.includes("urgent")),
      3000,
      "delivered after the abort",
    );
    const delivered = allSent(fake, info.id).find((t) => t.includes("urgent"))!;
    expect(delivered.startsWith(AGENT_INTERRUPT_NOTE)).toBe(true);
    expect(fake.sessionForAgent(info.id)).not.toBe(session);
  });

  it("a member's send-now gets the member note", async () => {
    const fake = fakeBackend();
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr, "codex");
    await startTurn(mgr, fake, info.id);

    void mgr.sendMessage(info.id, "change of plan", "Boss", undefined, undefined, {
      sendNow: true,
    });
    await waitUntil(
      () => allSent(fake, info.id).some((t) => t.includes("change of plan")),
      3000,
      "delivered after the abort",
    );
    const delivered = allSent(fake, info.id).find((t) =>
      t.includes("change of plan"),
    )!;
    expect(delivered.startsWith(MEMBER_INTERRUPT_NOTE)).toBe(true);
  });

  it("the note is consumed with its delivery; a later plain queue gets none", async () => {
    const fake = fakeBackend();
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr, "codex");
    await startTurn(mgr, fake, info.id);
    steer(mgr, info.id, "urgent");
    await waitUntil(
      () => allSent(fake, info.id).some((t) => t.includes("urgent")),
      3000,
      "steer delivered",
    );
    // The steer's delivery is itself a parked turn; finish it.
    fake.sessionForAgent(info.id)!.completeTurn();
    await waitUntil(
      () => stateOf(mgr, info.id) === "waiting_for_response",
      2000,
      "idle",
    );

    const session = await startTurn(mgr, fake, info.id, "next job");
    // A plain agent message while busy (a real denial or refusal in this turn
    // stays the model's own business): no interruption, so no cause note.
    mgr.enqueueMessage(info.id, { sender: SENDER, text: "fyi" });
    session.completeTurn();
    await waitUntil(
      () => session.sent.some((m) => m.text.includes("fyi")),
      2000,
      "plain flush",
    );
    const plain = session.sent.find((m) => m.text.includes("fyi"))!.text;
    expect(plain.includes(AGENT_INTERRUPT_NOTE)).toBe(false);
    expect(plain.includes(MEMBER_INTERRUPT_NOTE)).toBe(false);
  });
});

describe("edit after a tool-boundary delivery", () => {
  const PARENT_SID = "fake-session-1";
  const FORK_SID = "forked-1";

  it("a boundary-delivered agent message with the same text does not shift the edit target", async () => {
    // Agent entries carry no username, so a member message sent without one
    // has the same edit text: the collision the exclusion guards against.
    const claudeHome = join(STATE_ROOT, "claude-home");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
    const fake = fakeBackend({
      toolBoundaryDelivery: true,
      forkResult: {
        kind: "fork",
        sessionId: FORK_SID,
        forkedFromSessionId: PARENT_SID,
      },
      // The transcript: the hook context is not a user message, so the only
      // user messages are the two the member sent.
      sessionMessages: [
        { uuid: "u-0", role: "user", text: "kickoff" },
        { uuid: "a-0", role: "assistant", text: "..." },
        { uuid: "u-1", role: "user", text: "same words" },
        { uuid: "a-1", role: "assistant", text: "..." },
      ],
    });
    const { mgr } = makeManager(fake);
    const info = await spawn(mgr);
    const session = await startTurn(mgr, fake, info.id);
    steer(mgr, info.id, "same words");
    expect(session.toolBoundary()).not.toBeNull();
    session.completeTurn();
    await waitUntil(
      () => stateOf(mgr, info.id) === "waiting_for_response",
      2000,
      "idle",
    );
    void mgr.sendMessage(info.id, "same words");
    await waitUntil(
      () => session.sent.some((m) => m.text === "same words"),
      2000,
      "member message sent",
    );
    session.completeTurn();
    await waitUntil(
      () => stateOf(mgr, info.id) === "waiting_for_response",
      2000,
      "idle again",
    );

    const dir = claudeProjectDir(info.cwd, { CLAUDE_CONFIG_DIR: claudeHome });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${FORK_SID}.jsonl`), "");
    const memberEntry = loadLog(info.id, PARENT_SID).find(
      (e) =>
        e.kind === "user_message" &&
        e.content === "same words" &&
        e.metadata?.delivery === undefined,
    )!;
    expect(memberEntry).toBeDefined();
    // The edited turn parks like every turn here; the fork is what counts.
    void mgr.editMessage(info.id, memberEntry.id, "other words");
    await waitUntil(
      () => !!loadSessionsMap(info.id)[FORK_SID],
      2000,
      "fork persisted",
    );
    // Forked right before the member's own message, not somewhere else.
    expect(fake.lastForkTarget).toBe("u-1");
  });
});
