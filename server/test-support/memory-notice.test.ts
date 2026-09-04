// Session-start memory-size notice (task f1a08f05). Seam: startTestServer() +
// FakeBackend, same shape as the context-fullness notice tests. Zero LLM.
//
// What this freezes:
//   - An auto-loaded scope at or over MEMORY_NOTICE_FILL_RATIO of its cap puts
//     a `memory-check` block on the FIRST send of the conversation, and the
//     wrapped text still unwraps back to the bare user payload.
//   - It fires once: the next turn in the same conversation carries nothing.
//   - /clear starts a new conversation, which re-arms it.
//   - A model change rebuilds the session WITHOUT starting a new conversation,
//     so it must NOT re-fire (this is what memoryNoticeFired is for).
//   - Memory comfortably under the cap produces no notice at all.
//   - A /clear while a send is parked does NOT let the stale send consume the
//     fresh conversation's notice (the send-accept generation guard).
//   - A FAILED edit-fork that rolls back restores the SAME conversation, so an
//     already-delivered notice stays delivered.
//   - The paths that build the session BEFORE resetting the conversation (a
//     different-session resume, a SUCCESSFUL edit-fork) still arm the new
//     conversation's notice - arming runs at both points on purpose.
import { describe, it, expect, afterEach, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { stripOutboundEnvelope } from "../agent-turn.ts";
import { MEMORY_CAPS } from "../memory-store.ts";
import { STATE_ROOT } from "../config.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { loadLog } from "../persistence.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  clearTestManagedOfficeEnv();
});

const WAIT_MS = 20_000;
setDefaultTimeout(60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

// Point CLAUDE_CONFIG_DIR at a temp dir so the Claude resume preflight that a
// model change runs consults a path we control (same trick as
// context-usage.test.ts). Returns that dir.
let homeSuffix = 0;
function wireClaudeHome(): string {
  const suffix = `mem-notice-${++homeSuffix}`;
  const claudeHome = join(STATE_ROOT, `claude-home-${suffix}`);
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
  return claudeHome;
}

function backend(): FakeBackend {
  return new FakeBackend({
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
}

/** Write `chars` worth of memory lines into a room's memory file. Lines are
 *  what renderCapped counts, so the file is built out of realistic ones. */
function seedRoomMemory(roomId: string, chars: number): void {
  const dir = join(STATE_ROOT, "memory", "rooms");
  mkdirSync(dir, { recursive: true });
  const line = `- Tester, 2026-08-01: ${"filler fact ".repeat(8)}`;
  const lines: string[] = [];
  let size = 0;
  while (size < chars) {
    lines.push(line);
    size += line.length + 1;
  }
  writeFileSync(join(dir, `${roomId}.md`), lines.join("\n") + "\n");
}

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
  agentType: AgentInfo["agentType"] = "claude",
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    agentType,
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

async function runTurn(
  srv: TestServer,
  agentId: string,
  text: string,
): Promise<void> {
  const r = srv.agentManager.enqueueMessage(agentId, {
    sender: { kind: "user", username: "Boss" },
    text,
  });
  if (!r.ok) throw new Error(`enqueue failed: ${r.error}`);
  await waitUntil(() => {
    const s = srv.agentManager.getAgent(agentId)?.state;
    return s !== undefined && s !== "thinking" && s !== "tool_executing";
  }, `turn processed: ${text}`);
}

describe("session-start memory-size notice (task f1a08f05)", () => {
  it("still sends the memory notice to a Codex agent", async () => {
    const srv = await startTestServer({ fakeBackend: backend() });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    seedRoomMemory(room.id, Math.round(MEMORY_CAPS.room * 0.9));
    const agent = await spawnAgent(srv, "Codex Worker", room.id, "codex");

    await runTurn(srv, agent.id, "one");
    const sent = srv.fakeBackend.sessionForAgent(agent.id)!.sent[0].text;
    expect(sent).toContain("--- begin isomux: memory-check ---");
    expect(sent).toContain("[memory check:");
    expect(sent).not.toContain("context check");
  });

  it("rides the first send, once per conversation, and re-arms on /clear", async () => {
    const srv = await startTestServer({ fakeBackend: backend() });
    server = srv;
    // After startTestServer: the harness installs its own env provider.
    const claudeHome = wireClaudeHome();
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    // Comfortably over the 0.8 ratio of the room cap, under the cap itself, so
    // the notice is driven by the ratio rather than by truncation.
    seedRoomMemory(room.id, Math.round(MEMORY_CAPS.room * 0.9));
    const agent = await spawnAgent(srv, "Worker", room.id);
    const sess = () => srv.fakeBackend.sessionForAgent(agent.id)!;
    const lastSent = () => sess().sent[sess().sent.length - 1].text;

    await runTurn(srv, agent.id, "one");
    const turn1 = lastSent();
    expect(turn1.startsWith("--- begin isomux: memory-check ---")).toBe(true);
    expect(turn1).toContain(
      "[memory check: auto-loaded memory is close to its",
    );
    expect(turn1).toMatch(
      new RegExp(`Room "${room.name}" at 9\\d% of its cap`),
    );
    const unwrapped = stripOutboundEnvelope(turn1);
    expect(unwrapped).not.toContain("---");
    expect(unwrapped.endsWith("one")).toBe(true);

    // Once per conversation.
    await runTurn(srv, agent.id, "two");
    expect(lastSent()).not.toContain("memory check");
    expect(lastSent()).not.toContain("--- begin isomux:");

    // A model change rebuilds the session but continues the conversation. Seed
    // the session file the Claude resume preflight looks for first.
    const sessionId = srv.agentManager.getCurrentSessionId(agent.id)!;
    const dir = claudeProjectDir(srv.agentManager.getAgent(agent.id)!.cwd, {
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), "");
    await srv.agentManager.editAgent(agent.id, { modelFamily: "sonnet" });
    await runTurn(srv, agent.id, "three");
    expect(lastSent()).not.toContain("memory check");

    // /clear starts a new conversation, which re-arms the notice.
    await srv.agentManager.newConversation(agent.id);
    await runTurn(srv, agent.id, "four");
    expect(lastSent()).toContain("[memory check:");
  });

  it("says nothing when every scope is well under its cap", async () => {
    const srv = await startTestServer({ fakeBackend: backend() });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    seedRoomMemory(room.id, Math.round(MEMORY_CAPS.room * 0.3));
    const agent = await spawnAgent(srv, "Worker", room.id);
    const sess = () => srv.fakeBackend.sessionForAgent(agent.id)!;

    await runTurn(srv, agent.id, "one");
    const turn1 = sess().sent[sess().sent.length - 1].text;
    expect(turn1).not.toContain("memory check");
    expect(turn1).not.toContain("--- begin isomux:");
  });
});

/** Seed the existence-only session file the Claude resume preflight looks for. */
function seedClaudeFile(claudeHome: string, cwd: string, sessionId: string) {
  const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: claudeHome });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "");
}

describe("memory notice: conversation-boundary races", () => {
  it("a /clear during send() does not let the stale send burn the fresh conversation's notice", async () => {
    // manualSend parks every send() so turn 1 can be held in the send window,
    // /clear'd, and only then released - the race where an old-session send
    // resolves after replaceSession. The consume must skip via the generation
    // guard. A value comparison would not: the fresh conversation formats the
    // IDENTICAL notice text from the same memory.
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { manualSend: true } }),
    });
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    seedRoomMemory(room.id, Math.round(MEMORY_CAPS.room * 0.9));
    const agent = await spawnAgent(srv, "Worker", room.id);
    const send = (text: string) =>
      srv.agentManager.enqueueMessage(agent.id, {
        sender: { kind: "user", username: "Boss" },
        text,
      });
    const curSess = () => srv.fakeBackend.sessionForAgent(agent.id)!;

    send("one");
    await waitUntil(() => curSess().sent.length === 1, "turn1 parked");
    const s1 = curSess();
    expect(s1.sent[0].text).toContain("[memory check:");

    // Swap the conversation WHILE the send is parked, then release it.
    await srv.agentManager.newConversation(agent.id);
    s1.releaseSends();
    await sleep(50); // let the stale continuation unwind past the consume

    // The fresh conversation must still get its notice.
    send("two");
    await waitUntil(() => curSess() !== s1, "turn2 session woke");
    const s2 = curSess();
    await waitUntil(() => s2.sent.length === 1, "turn2 parked");
    expect(s2.sent[0].text).toContain("[memory check:");
    s2.releaseSends();
  });

  it("a failed edit-fork that rolls back keeps the notice fired", async () => {
    // Rollback puts the SAME conversation back, so its notice already went out.
    // Without the stash/restore, resetContextUsage would clear the fired flag
    // and the next turn would repeat the notice.
    const PARENT_SID = "fake-session-1"; // deterministic: first createSession
    const FORK_SID = "forked-mem-1";
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({
        session: {
          onSend: (text, _a, s) => {
            if (text.includes("edited")) throw new Error("boom: fork send");
            s.completeTurn({ text: "reply" });
          },
        },
        sessionMessages: [
          { uuid: "u-first", role: "user", text: "[Boss] first" },
          { uuid: "a-1", role: "assistant", text: "reply" },
        ],
        forkResult: {
          kind: "fork",
          sessionId: FORK_SID,
          forkedFromSessionId: PARENT_SID,
        },
      }),
    });
    server = srv;
    const claudeHome = wireClaudeHome();
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    seedRoomMemory(room.id, Math.round(MEMORY_CAPS.room * 0.9));
    const agent = await spawnAgent(srv, "Worker", room.id);
    const sess = () => srv.fakeBackend.sessionForAgent(agent.id)!;
    const lastSent = () => sess().sent[sess().sent.length - 1].text;

    await runTurn(srv, agent.id, "first");
    expect(lastSent()).toContain("[memory check:");
    const parentSid = srv.agentManager.getCurrentSessionId(agent.id)!;
    expect(parentSid).toBe(PARENT_SID);
    const cwd = srv.agentManager.getAgent(agent.id)!.cwd;
    // Both preflights must pass: the fork's createSession AND the rollback's.
    seedClaudeFile(claudeHome, cwd, parentSid);
    seedClaudeFile(claudeHome, cwd, FORK_SID);

    const firstMsgId = loadLog(agent.id, parentSid).find(
      (e) => e.kind === "user_message" && e.content === "first",
    )!.id;
    await srv.agentManager.editMessage(agent.id, firstMsgId, "edited first");
    await waitUntil(
      () => srv.agentManager.getCurrentSessionId(agent.id) === parentSid,
      "rolled back to the parent session",
    );

    // The failed fork turn leaves the agent in `error`, which rejects sends.
    // Resuming the SAME session id recovers it without starting a new
    // conversation (resetContextUsage is skipped on a same-id resume), and it
    // rebuilds the session - which re-runs the arming step. That makes this the
    // sharp version of the check: arming must see the RESTORED fired flag and
    // arm nothing.
    await srv.agentManager.resume(agent.id, parentSid);
    await waitUntil(
      () => srv.agentManager.getAgent(agent.id)?.state !== "error",
      "recovered from the failed fork",
    );
    await runTurn(srv, agent.id, "after-rollback");
    expect(lastSent()).not.toContain("memory check");
  });
});

describe("memory notice: session built BEFORE the conversation reset", () => {
  // /clear resets and then builds the session lazily; a different-session resume
  // and a successful edit-fork build FIRST and reset after. Arming has to be
  // right either way, which is why it runs at both points.
  it("a resume to a different session arms the new conversation's notice", async () => {
    const srv = await startTestServer({ fakeBackend: backend() });
    server = srv;
    const claudeHome = wireClaudeHome();
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    seedRoomMemory(room.id, Math.round(MEMORY_CAPS.room * 0.9));
    const agent = await spawnAgent(srv, "Worker", room.id);
    const sess = () => srv.fakeBackend.sessionForAgent(agent.id)!;
    const lastSent = () => sess().sent[sess().sent.length - 1].text;

    await runTurn(srv, agent.id, "one");
    expect(lastSent()).toContain("[memory check:");
    await runTurn(srv, agent.id, "two");
    expect(lastSent()).not.toContain("memory check");

    // A DIFFERENT session id is a new conversation: createSession runs first
    // (arming null off the old fired flag), then resetContextUsage clears the
    // flag - so only the re-arm inside the reset can save the notice.
    const other = "other-session-1";
    seedClaudeFile(claudeHome, srv.agentManager.getAgent(agent.id)!.cwd, other);
    await srv.agentManager.resume(agent.id, other);
    await runTurn(srv, agent.id, "three");
    expect(lastSent()).toContain("[memory check:");
  });

  it("a successful edit-fork arms the fork's notice", async () => {
    const PARENT_SID = "fake-session-1";
    const FORK_SID = "forked-ok-1";
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({
        session: { onSend: (_t, _a, s) => s.completeTurn({ text: "reply" }) },
        sessionMessages: [
          { uuid: "u-first", role: "user", text: "[Boss] first" },
          { uuid: "a-1", role: "assistant", text: "reply" },
        ],
        forkResult: {
          kind: "fork",
          sessionId: FORK_SID,
          forkedFromSessionId: PARENT_SID,
        },
      }),
    });
    server = srv;
    const claudeHome = wireClaudeHome();
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    seedRoomMemory(room.id, Math.round(MEMORY_CAPS.room * 0.9));
    const agent = await spawnAgent(srv, "Worker", room.id);
    const sess = () => srv.fakeBackend.sessionForAgent(agent.id)!;
    const lastSent = () => sess().sent[sess().sent.length - 1].text;

    await runTurn(srv, agent.id, "first");
    expect(lastSent()).toContain("[memory check:");
    const parentSid = srv.agentManager.getCurrentSessionId(agent.id)!;
    expect(parentSid).toBe(PARENT_SID);
    seedClaudeFile(
      claudeHome,
      srv.agentManager.getAgent(agent.id)!.cwd,
      FORK_SID,
    );

    const firstMsgId = loadLog(agent.id, parentSid).find(
      (e) => e.kind === "user_message" && e.content === "first",
    )!.id;
    await srv.agentManager.editMessage(agent.id, firstMsgId, "edited first");
    await waitUntil(
      () => srv.agentManager.getCurrentSessionId(agent.id) === FORK_SID,
      "forked to the new session",
    );
    // The fork's own first turn is the edited message itself.
    expect(lastSent()).toContain("[memory check:");
  });
});
