// Task 8c15e93e: a Codex message right after new-conversation failed with
// "CodexSession.send: session is closed" and left the agent in error with the
// message queued. The clear left the agent dormant, the message woke a fresh
// session, and a settings edit (a cwd PATCH) swapped that session out while
// its send() still waited for the session to boot. The send threw the closed-
// session error instead of the swap, so the flush put the agent in error.
//
// Seam: the DI manager with a Codex-like fake session. Its send() waits for a
// boot gate the test opens, and throws when the session closed meanwhile,
// like CodexSession.send (backends/codex/adapter.ts).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { FakeBackend, FakeSession } from "./fake-backend.ts";
import type {
  AttachmentSpec,
  BackendSession,
  CreateSessionOptions,
} from "../backends/types.ts";
import type { EventHandler } from "../internal-types.ts";
import type { LogEntry, QueuedMessage, RoomWire } from "../../shared/types.ts";

const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];
const SENDER: QueuedMessage["sender"] = {
  kind: "agent",
  agentId: "agent-lead",
  agentName: "Lead",
  roomName: "room-a",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

class CodexLikeSession extends FakeSession {
  // How many sends reached the boot wait.
  sendEntered = 0;
  private boot!: () => void;
  private readonly booted: Promise<void>;
  constructor(
    opts: CreateSessionOptions,
    sessionId: string,
    isResume: boolean,
  ) {
    super(opts, sessionId, isResume, { autoSystemInit: false });
    this.booted = new Promise<void>((r) => (this.boot = r));
  }
  // The test's stand-in for initialize + thread/start finishing.
  finishBoot(): void {
    if (this.closed) return;
    this.push({
      kind: "system_init",
      sessionId: this.sessionId,
      slashCommands: [],
    });
    this.boot();
  }
  override async send(text: string, a?: AttachmentSpec[]): Promise<void> {
    this.sendEntered++;
    await this.booted;
    if (this.closed) throw new Error("CodexSession.send: session is closed");
    await super.send(text, a);
  }
  override close(): void {
    super.close();
    // A closed client fails the bootstrap's in-flight request.
    this.boot();
  }
}

class CodexLikeBackend extends FakeBackend {
  private n = 0;
  constructor() {
    super({ storedSessionState: () => "durable" });
  }
  override createSession(opts: CreateSessionOptions): BackendSession {
    this.createSessionCount++;
    const s = new CodexLikeSession(opts, `codex-thread-${++this.n}`, false);
    this.sessions.push(s);
    return s;
  }
  override resumeSession(
    sessionId: string,
    opts: CreateSessionOptions,
  ): BackendSession {
    this.resumeSessionCount++;
    const s = new CodexLikeSession(opts, sessionId, true);
    this.sessions.push(s);
    return s;
  }
}

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});
const activeFakes: FakeBackend[] = [];
afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
});

async function setup() {
  const fake = new CodexLikeBackend();
  activeFakes.push(fake);
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
  const info = await mgr.spawn(
    "Codex Worker",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
    undefined,
    undefined,
    undefined,
    undefined,
    "codex",
  );
  if (!info) throw new Error("spawn returned null");
  // One completed turn, so the agent has a live, booted session to clear.
  void mgr.sendMessage(info.id, "warm-up");
  const first = (await waitForSession(fake, 1)) as CodexLikeSession;
  first.finishBoot();
  await waitUntil(() => first.sent.length > 0, "warm-up sent");
  first.completeTurn({ text: "ok" });
  await waitUntil(
    () => mgr.getAgent(info.id)?.state === "waiting_for_response",
    "warm-up done",
  );
  return { fake, mgr, logs, id: info.id };
}

async function waitForSession(
  fake: FakeBackend,
  count: number,
): Promise<FakeSession> {
  await waitUntil(() => fake.sessions.length >= count, `session ${count}`);
  return fake.sessions[count - 1];
}

const queueOf = (mgr: ReturnType<typeof createAgentManager>, id: string) =>
  mgr.getAllAgents().find((a) => a.id === id)?.queue ?? [];

// A settings edit (a cwd change) swaps the woken session while its send waits
// for the boot; the replacement then boots.
async function swapWhileBooting(
  fake: FakeBackend,
  mgr: ReturnType<typeof createAgentManager>,
  id: string,
): Promise<{ woken: CodexLikeSession; replacement: CodexLikeSession }> {
  const woken = (await waitForSession(fake, 2)) as CodexLikeSession;
  await waitUntil(() => woken.sendEntered === 1, "send waits for the boot");
  const cwd = join(STATE_ROOT, "tools");
  mkdirSync(cwd, { recursive: true });
  const edited = mgr.editAgent(id, { cwd });
  const replacement = (await waitForSession(fake, 3)) as CodexLikeSession;
  await edited;
  expect(woken.closed).toBe(true);
  replacement.finishBoot();
  return { woken, replacement };
}

describe("Codex: a message right after new-conversation", () => {
  it("goes to the new session once it boots", async () => {
    const { fake, mgr, logs, id } = await setup();
    await mgr.newConversation(id);
    expect(
      mgr.enqueueMessage(id, { sender: SENDER, text: "BRIEF" }),
    ).toMatchObject({ ok: true });
    const woken = (await waitForSession(fake, 2)) as CodexLikeSession;
    expect(woken.isResume).toBe(false);
    woken.finishBoot();
    await waitUntil(
      () => woken.sent.some((m) => m.text.includes("BRIEF")),
      "brief delivered",
    );
    expect(mgr.getAgent(id)?.state).toBe("thinking");
    expect(logs.some((e) => e.kind === "error")).toBe(false);
  });

  it("goes to the replacement session when a settings edit swaps the woken one while it boots", async () => {
    const { fake, mgr, logs, id } = await setup();
    await mgr.newConversation(id);
    mgr.enqueueMessage(id, { sender: SENDER, text: "BRIEF" });
    const woken = (await waitForSession(fake, 2)) as CodexLikeSession;
    // The flush has called send(), which waits for the boot.
    await waitUntil(() => woken.sendEntered === 1, "send waits for the boot");
    expect(woken.sent).toHaveLength(0);

    const cwd = join(STATE_ROOT, "tools");
    mkdirSync(cwd, { recursive: true });
    const edited = mgr.editAgent(id, { cwd });
    const replacement = (await waitForSession(fake, 3)) as CodexLikeSession;
    await edited;
    expect(woken.closed).toBe(true);
    replacement.finishBoot();

    await waitUntil(
      () => replacement.sent.some((m) => m.text.includes("BRIEF")),
      "brief delivered to the replacement session",
    );
    expect(mgr.getAgent(id)?.state).toBe("thinking");
    expect(queueOf(mgr, id)).toHaveLength(0);
    expect(
      logs.some(
        (e) => e.kind === "error" || e.content.includes("session is closed"),
      ),
    ).toBe(false);
  });

  it("a member's direct message goes to the replacement session, shown once in the chat", async () => {
    const { fake, mgr, logs, id } = await setup();
    await mgr.newConversation(id);
    void mgr.sendMessage(id, "DIRECT", "nil");
    const { woken, replacement } = await swapWhileBooting(fake, mgr, id);
    await waitUntil(
      () => replacement.sent.some((m) => m.text.includes("DIRECT")),
      "direct message delivered to the replacement session",
    );
    expect(woken.sent).toHaveLength(0);
    expect(mgr.getAgent(id)?.state).toBe("thinking");
    await waitUntil(() => queueOf(mgr, id).length === 0, "queue drained");
    expect(logs.some((e) => e.kind === "error")).toBe(false);
    expect(
      logs.filter((e) => e.kind === "user_message" && e.content === "DIRECT"),
    ).toHaveLength(1);
    // Sent before the swap, so not marked as queued during a busy turn.
    const prompt = replacement.sent.find((m) => m.text.includes("DIRECT"))!;
    expect(prompt.text).not.toContain("queued while you were processing");
  });

  it("a member's skill goes to the replacement session, shown once in the chat", async () => {
    const skillDir = join(STATE_ROOT, "skills", "codexskill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "CODEX-SKILL-BODY");
    const { fake, mgr, logs, id } = await setup();
    await mgr.newConversation(id);
    void mgr.sendMessage(id, "/codexskill", "nil");
    const { woken, replacement } = await swapWhileBooting(fake, mgr, id);
    await waitUntil(
      () => replacement.sent.some((m) => m.text.includes("CODEX-SKILL-BODY")),
      "skill delivered to the replacement session",
    );
    expect(woken.sent).toHaveLength(0);
    expect(logs.some((e) => e.kind === "error")).toBe(false);
    expect(
      logs.filter(
        (e) => e.kind === "user_message" && e.content === "/codexskill",
      ),
    ).toHaveLength(1);
  });

  it("a member's Stop while the woken session boots ends the message: no session gets it", async () => {
    const { fake, mgr, id } = await setup();
    await mgr.newConversation(id);
    void mgr.sendMessage(id, "DIRECT", "nil");
    const woken = (await waitForSession(fake, 2)) as CodexLikeSession;
    await waitUntil(() => woken.sendEntered === 1, "send waits for the boot");
    await mgr.abort(id);
    await sleep(100);
    // Boot whatever the Stop left, so a message queued again would go out.
    for (const s of fake.sessions.slice(1))
      if (!s.closed) (s as CodexLikeSession).finishBoot();
    await sleep(300);
    expect(
      fake.sessions.some((s) => s.sent.some((m) => m.text.includes("DIRECT"))),
    ).toBe(false);
    expect(queueOf(mgr, id)).toHaveLength(0);
    expect(mgr.getAgent(id)?.state).toBe("waiting_for_response");
  });
});
