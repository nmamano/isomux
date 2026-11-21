// The manager's part of the office's own link to an agent's conversation
// (task 3a2de351): at each turn end the agent's current session files go to
// its store (keepSessionFiles); a resume tells the backend where that store is; a cwd change puts a
// swept transcript back from the store before it moves it.
//
// Seam: the DI manager with a FakeBackend that plays Claude's files: its
// sessionFiles is the real Claude backend's, and the test writes the
// transcript where Claude would (claudeProjectDir of the session's env).
// What the Claude backend does with the store before the CLI starts is
// server/backends/claude-engine-session.test.ts; the store's own rules are
// server/engine-session-store.test.ts.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { officeAgentHost } from "../agent-host.ts";
import { createAgentManager } from "../agent-manager.ts";
import { claudeBackend } from "../backends/claude.ts";
import { STATE_ROOT } from "../config.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";

type Manager = ReturnType<typeof createAgentManager>;

let claudeHome: string;
beforeEach(() => {
  claudeHome = join(STATE_ROOT, `engine-session-claude-${crypto.randomUUID()}`);
  mkdirSync(claudeHome, { recursive: true });
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
});
afterEach(() => clearTestManagedOfficeEnv());

function room(id: string): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: false };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(5);
  }
}

const transcriptOf = (s: FakeSession, cwd = STATE_ROOT) =>
  join(claudeProjectDir(cwd, s.opts.env), `${s.sessionId}.jsonl`);

const storeOf = (agentId: string, sessionId: string) =>
  join(officeAgentHost().agentRoot(), "engine-sessions", agentId, sessionId);

// A Claude-like fake: each turn appends a line to the session's transcript
// and a subagent file under the session's folder, then ends.
function claudeLike(): FakeBackend {
  const fake = new FakeBackend({
    session: {
      onSend: (text, _attachments, s) => {
        const transcript = transcriptOf(s, s.opts.cwd);
        mkdirSync(join(transcript, "..", s.sessionId, "subagents"), {
          recursive: true,
        });
        writeFileSync(transcript, `${text}\n`, { flag: "a" });
        writeFileSync(
          join(transcript, "..", s.sessionId, "subagents", "agent-a.jsonl"),
          `${text}\n`,
          { flag: "a" },
        );
        s.completeTurn({ text: "ok" });
      },
    },
  });
  return Object.assign(fake, { sessionFiles: claudeBackend.sessionFiles });
}

async function spawned(
  fake: FakeBackend,
): Promise<{ mgr: Manager; agentId: string }> {
  const roomId = `engine-session-${crypto.randomUUID()}`;
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: [room(roomId)] }),
    initialRooms: [],
    findUser: (person) =>
      (
        "username" in person
          ? person.username === "tester"
          : person.userId === "user-a"
      )
        ? { id: "user-a", role: "member" }
        : undefined,
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    `Engine ${roomId}`,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    "fake",
    "high",
    "tester",
    "claude",
    undefined,
    "user-a",
  );
  return { mgr, agentId: info!.id };
}

const notes = (mgr: Manager, agentId: string) =>
  mgr
    .getAgentLogs(agentId)
    .filter((e) =>
      (e.message ?? []).some(
        (part) =>
          typeof part !== "string" &&
          part.key.startsWith("systemEntries.sessionNotResumable"),
      ),
    ).length;

describe("the office's link to an agent's Claude session", () => {
  // MUTANT: no keep at turn_completed (died on the wait for the store).
  // A keep with a fresh env in place of the launched one stays green: the
  // session's pinned Claude root makes them the same (built 2026-11-21,
  // envForHints and buildSessionEnv).
  it("keeps the current session's files in the agent's store at each turn end", async () => {
    const fake = claudeLike();
    const { mgr, agentId } = await spawned(fake);
    try {
      await mgr.sendMessage(agentId, "first", "tester");
      const s = fake.sessions[0];
      expect(s.opts.env?.CLAUDE_CONFIG_DIR).toBe(claudeHome);
      const kept = join(storeOf(agentId, s.sessionId), `${s.sessionId}.jsonl`);
      await until(() => existsSync(kept), "the transcript reached the store");
      expect(statSync(kept).ino).toBe(statSync(transcriptOf(s)).ino);
      const sub = join(
        storeOf(agentId, s.sessionId),
        s.sessionId,
        "subagents",
        "agent-a.jsonl",
      );
      await until(() => existsSync(sub), "the subagent file reached the store");
    } finally {
      await mgr.kill(agentId);
    }
  });

  // MUTANT: createSession does not set engineSessionStore on a resume (the
  // backend has nothing to restore from); sets it to the agent's folder,
  // not the resumed session's.
  it("tells the backend where the resumed session's store is", async () => {
    const fake = claudeLike();
    const { mgr, agentId } = await spawned(fake);
    try {
      await mgr.sendMessage(agentId, "first", "tester");
      const sid = fake.sessions[0].sessionId;
      await mgr.resume(agentId, sid);
      const resumed = fake.sessions.at(-1)!;
      expect([resumed.isResume, resumed.sessionId]).toEqual([true, sid]);
      expect(resumed.opts.engineSessionStore).toBe(storeOf(agentId, sid));
      // A new conversation resumes nothing and has no store.
      expect(fake.sessions[0].opts.engineSessionStore).toBeUndefined();
    } finally {
      await mgr.kill(agentId);
    }
  });

  // The engine swept the transcript while the agent was idle; the store
  // has it. The cwd change puts it back and moves it, and the agent keeps
  // its conversation.
  // MUTANTS: the cwd edit runs no restore before the move (the edit finds
  // no file and starts a new conversation); the restore into the new cwd's
  // folder after the move check (same).
  it("puts a swept transcript back from the store when the folder changes, and keeps the conversation", async () => {
    const fake = claudeLike();
    const { mgr, agentId } = await spawned(fake);
    try {
      await mgr.sendMessage(agentId, "first", "tester");
      const s = fake.sessions[0];
      const kept = join(storeOf(agentId, s.sessionId), `${s.sessionId}.jsonl`);
      await until(() => existsSync(kept), "the transcript reached the store");
      const whole = readFileSync(kept, "utf8");
      unlinkSync(transcriptOf(s));
      const newCwd = join(
        STATE_ROOT,
        `engine-session-moved-${crypto.randomUUID()}`,
      );
      mkdirSync(newCwd, { recursive: true });
      await mgr.editAgent(agentId, { cwd: newCwd });
      expect(mgr.getAgent(agentId)?.cwd).toBe(newCwd);
      expect(readFileSync(transcriptOf(s, newCwd), "utf8")).toBe(whole);
      expect(mgr.getCurrentSessionId(agentId)).toBe(s.sessionId);
      expect(notes(mgr, agentId)).toBe(0);
    } finally {
      await mgr.kill(agentId);
    }
  });
});
