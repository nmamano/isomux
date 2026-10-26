// OpenCode conversations across a change of env files and the profile key
// update (task df0e7b51), through AgentManager with a backend that stores each
// session under the environment key it was created with, as OpenCode stores
// it in that key's profile:
// - a turn after the env file set changed resumes the same conversation;
// - the first boot after the update keeps a member on their legacy profile;
// - the boot runs the pending profile moves before the restore, within one
//   time limit;
// - a stored session that cannot be resumed leaves a note in the chat and a
//   server log line (missing), or only the log line (empty);
// - an explicit resume brings back a missing session the agent owns, and only
//   one it owns.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync } from "fs";
import { join } from "path";

import { OfficeState } from "../../shared/office-state.ts";
import type { LogEntry, RoomWire } from "../../shared/types.ts";
import {
  createAgentManager,
  createProductionAgentManager,
  type AgentManager,
} from "../agent-manager.ts";
import type {
  BackendSession,
  CreateSessionOptions,
  StoredSessionState,
} from "../backends/types.ts";
import {
  cleanUpProfileFixtures,
  fakeCli,
  profile,
} from "../backends/opencode/profile-fixture.ts";
import { openCodeProfilePaths } from "../backends/opencode/profile-paths.ts";
import { STATE_ROOT } from "../config.ts";
import {
  environmentSourceKeyForUserId,
  legacyEnvironmentSourceKeyForUserId,
  setOfficeEnvFileProvider,
} from "../env-loader.ts";
import {
  migrateProfileKeysOnce,
  readProfileKeyState,
} from "../opencode-profile-keys.ts";
import {
  appendLog,
  persistSessionCwd,
  saveAgents,
  type PersistedAgent,
} from "../persistence.ts";
import { claimUser } from "../users.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvPath,
  writeManagedOfficeEnv,
  writeManagedUserEnv,
} from "../user-env.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { removeStateDir } from "./temp-state.ts";

// Stores sessions per environment key, as OpenCode stores them per profile.
class ProfileStoreBackend extends FakeBackend {
  readonly stored = new Map<string, Map<string, StoredSessionState>>();
  readonly recoverCalls: { sessionId: string; environmentKey?: string }[] = [];
  // The sessions some other profile holds: recoverStoredSession brings them.
  readonly elsewhere = new Set<string>();

  constructor() {
    super({
      session: {
        onSend: (text, _attachments, session) =>
          session.completeTurn({ text: `reply to ${text}` }),
      },
    });
  }

  put(key: string, sessionId: string, state: StoredSessionState = "durable") {
    if (!this.stored.has(key)) this.stored.set(key, new Map());
    this.stored.get(key)!.set(sessionId, state);
  }

  stateIn(key: string | undefined, sessionId: string): StoredSessionState {
    return this.stored.get(key ?? "")?.get(sessionId) ?? "missing";
  }

  override createSession(opts: CreateSessionOptions): BackendSession {
    const session = super.createSession(opts) as FakeSession;
    this.put(opts.environmentKey ?? "", session.sessionId);
    return session;
  }

  override inspectStoredSession(
    sessionId: string,
    opts?: { cwd: string; environmentKey?: string },
  ): StoredSessionState {
    return this.stateIn(opts?.environmentKey, sessionId);
  }

  override checkSessionResumable(
    sessionId: string,
    opts: { cwd: string; environmentKey?: string },
  ): string | null {
    return this.stateIn(opts.environmentKey, sessionId) === "durable"
      ? null
      : "The conversation is not stored in this profile.";
  }

  recoverStoredSession = async (
    sessionId: string,
    opts: { environmentKey?: string },
  ): Promise<boolean> => {
    this.recoverCalls.push({ sessionId, environmentKey: opts.environmentKey });
    if (!this.elsewhere.has(sessionId)) return false;
    this.put(opts.environmentKey ?? "", sessionId);
    return true;
  };
}

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: false,
  }));
}

function persisted(
  id: string,
  lastSessionId: string,
  userId: string | null,
): PersistedAgent {
  return {
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
    modelFamily: "opencode/fake",
    effort: "high",
    agentType: "opencode",
    lastSessionId,
    topic: null,
    customInstructions: null,
    userId,
    username: null,
  } as unknown as PersistedAgent;
}

function restoringManager(
  fake: FakeBackend,
  roomId: string,
  agents: PersistedAgent[],
  limitMs?: number,
): AgentManager {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms(roomId) }),
    initialRooms: [{ id: roomId, name: roomId, prompt: null, agents }],
    ...(limitMs === undefined ? {} : { profileKeyMoveLimitMs: limitMs }),
  });
  mgr.configureAgentTurnDeps();
  return mgr;
}

function spawningManager(fake: FakeBackend, roomId: string): AgentManager {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms(roomId) }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  return mgr;
}

async function waitFor(
  condition: () => boolean,
  what: string,
  detail: () => unknown = () => null,
) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`timed out: ${what} ${JSON.stringify(detail())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function turn(mgr: AgentManager, agentId: string, text: string) {
  mgr.enqueueMessage(agentId, {
    sender: { kind: "user", username: "tester" },
    text,
  });
  await waitFor(
    () =>
      mgr.getAgentLogs(agentId).some(
        // The fake replies to the text as sent, with its sender label.
        (entry) =>
          entry.kind === "text" &&
          entry.content.startsWith("reply to ") &&
          entry.content.endsWith(text),
      ) &&
      ["idle", "waiting_for_response"].includes(
        mgr.getAgent(agentId)?.state ?? "",
      ),
    `the reply to "${text}"`,
    () => ({
      state: mgr.getAgent(agentId)?.state,
      logs: mgr
        .getAgentLogs(agentId)
        .map((entry) => `${entry.kind}: ${entry.content.slice(0, 80)}`),
    }),
  );
}

async function spawnOpenCode(
  mgr: AgentManager,
  roomId: string,
  userId: string | null,
  name = `OpenCode ${roomId}`,
): Promise<string> {
  const info = await mgr.spawn(
    name,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    "opencode/fake",
    "high",
    undefined,
    "opencode",
    undefined,
    userId,
  );
  return info!.id;
}

// The server's console lines while `run` runs.
async function consoleLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines;
}

// What a log entry says, not how: its kind and its message keys.
function shape(entry: LogEntry): string {
  const keys = (entry.message ?? [])
    .map((part) => (typeof part === "string" ? "" : part.key))
    .join(",");
  return `${entry.kind}:${keys || entry.content}`;
}

// The system entries in `logs` whose shape does not occur in `baseline`.
function extraSystemEntries(logs: LogEntry[], baseline: LogEntry[]) {
  const known = new Set(baseline.map(shape));
  return logs.filter(
    (entry) => entry.kind === "system" && !known.has(shape(entry)),
  );
}

afterEach(() => {
  setOfficeEnvFileProvider(() => null);
  removeStateDir(join(STATE_ROOT, "opencode", "profile-keys.json"));
  removeStateDir(managedOfficeEnvPath());
  removeStateDir(managedUserEnvPath("u-env"));
  cleanUpProfileFixtures();
});

describe("an OpenCode conversation across an env file change", () => {
  // The incident: the office env file went away, the key moved, and the next
  // message started a new conversation in a profile without the old one.
  for (const userId of ["u-env", null])
    it(`resumes the same conversation after env files appear and go (${userId ? "member" : "unowned"})`, async () => {
      const fake = new ProfileStoreBackend();
      const roomId = `room-env-${userId ?? "unowned"}`;
      const mgr = spawningManager(fake, roomId);
      const agentId = await spawnOpenCode(mgr, roomId, userId);
      await turn(mgr, agentId, "first");
      const first = mgr.getCurrentSessionId(agentId);
      expect(first).not.toBeNull();

      const changes = [
        () => writeManagedOfficeEnv({ SHARED: "1" }),
        () => {
          if (userId) writeManagedUserEnv(userId, { OWN: "1" });
        },
        () => removeStateDir(managedOfficeEnvPath()),
      ];
      for (const [index, change] of changes.entries()) {
        expect(await mgr.demoteToLazy(agentId)).toBe(true);
        change();
        await turn(mgr, agentId, `after change ${index}`);
        expect(mgr.getCurrentSessionId(agentId)).toBe(first);
      }
      expect(fake.createSessionCount).toBe(1);
      expect(fake.resumeSessionCount).toBe(changes.length);
      fake.sessions.forEach((session) => session.close());
    });
});

describe("the first boot after the profile key update", () => {
  beforeEach(() => {
    removeStateDir(STATE_ROOT);
    mkdirSync(STATE_ROOT, { recursive: true });
  });

  // MUTANT: the production factory does not run the migration, so the key
  // falls back to the member's new key and the session is not there.
  it("keeps a member on the legacy profile that holds their conversation, also after their files change", async () => {
    const user = claimUser("Profile Upgrade Member");
    writeManagedOfficeEnv({ SHARED: "1" });
    writeManagedUserEnv(user.id, { OWN: "1" });
    const legacy = legacyEnvironmentSourceKeyForUserId(user.id);
    profile(legacy, { ses_old: "durable" });
    saveAgents([
      {
        id: "room-upgrade",
        name: "Upgrade",
        prompt: null,
        agents: [persisted("agent-upgrade", "ses_old", user.id)],
      },
    ]);
    const fake = new ProfileStoreBackend();
    fake.put(legacy, "ses_old");

    const mgr = createProductionAgentManager({ resolveBackend: () => fake });
    mgr.configureAgentTurnDeps();
    expect(readProfileKeyState()?.pins[user.id]).toBe(legacy);
    await mgr.restoreAgents();
    expect(mgr.getCurrentSessionId("agent-upgrade")).toBe("ses_old");

    removeStateDir(managedOfficeEnvPath());
    removeStateDir(managedUserEnvPath(user.id));
    expect(environmentSourceKeyForUserId(user.id)).toBe(legacy);
    fake.sessions.forEach((session) => session.close());
  });
});

describe("the pending profile moves at boot", () => {
  const SHARED = "legacy-shared-di";

  // The keeper holds two sessions in the shared profile, so the other owner's
  // agent is the one whose last session moves.
  function planSharedProfile(): void {
    profile(SHARED, { ses_moved: "durable" });
    migrateProfileKeysOnce({
      owners: [
        {
          userId: "u-keep",
          agents: [
            { agentId: "a-keep-1", agentType: "opencode", lastSessionId: "k1" },
            { agentId: "a-keep-2", agentType: "opencode", lastSessionId: "k2" },
          ],
        },
        {
          userId: "u-move",
          agents: [
            {
              agentId: "agent-move",
              agentType: "opencode",
              lastSessionId: "ses_moved",
            },
          ],
        },
      ],
      legacyKey: () => SHARED,
      profileExists: (key) => key === SHARED,
    });
    expect(readProfileKeyState()?.pendingMoves).toHaveLength(1);
  }

  it("moves the session into the owner's new profile before the restore inspects it", async () => {
    planSharedProfile();
    const fake = new ProfileStoreBackend();
    fake.put(SHARED, "ses_moved");
    const ownerKey = environmentSourceKeyForUserId("u-move");
    expect(ownerKey).not.toBe(SHARED);
    const cli = fakeCli({
      importSession: async (target, exported) => {
        cli.imports.push({ profileDir: target.profileDir, exported });
        if (target.profileDir === openCodeProfilePaths(ownerKey).profileDir)
          fake.put(ownerKey, "ses_moved");
      },
    });

    const mgr = restoringManager(fake, "room-move", [
      persisted("agent-move", "ses_moved", "u-move"),
    ]);
    await mgr.restoreAgents();
    expect(cli.imports.map((call) => call.profileDir)).toEqual([
      openCodeProfilePaths(ownerKey).profileDir,
    ]);
    expect(mgr.getCurrentSessionId("agent-move")).toBe("ses_moved");
    expect(readProfileKeyState()?.pendingMoves).toEqual([]);
    fake.sessions.forEach((session) => session.close());
  });

  // MUTANT: keep a failed move pending, so every boot runs it again.
  it("ends a failed move, so the next boot does not run it again", async () => {
    planSharedProfile();
    const fake = new ProfileStoreBackend();
    fakeCli({
      importSession: async () => {
        throw new Error("import exited 1");
      },
    });
    const mgr = restoringManager(fake, "room-move-failed", [
      persisted("agent-move", "ses_moved", "u-move"),
    ]);
    await mgr.restoreAgents();
    expect(readProfileKeyState()?.pendingMoves).toEqual([]);
  });

  // MUTANT: give each move its own limit, or await the moves with no limit.
  it("continues the boot when the moves exceed their time limit, and keeps the move for the next boot", async () => {
    planSharedProfile();
    const fake = new ProfileStoreBackend();
    fakeCli({ importSession: () => new Promise<void>(() => {}) });
    const mgr = restoringManager(
      fake,
      "room-move-hung",
      [persisted("agent-move", "ses_moved", "u-move")],
      100,
    );
    const outcome = await Promise.race([
      mgr.restoreAgents().then(() => "restored"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(outcome).toBe("restored");
    expect(readProfileKeyState()?.pendingMoves).toHaveLength(1);
  });
});

describe("a stored conversation that cannot be resumed", () => {
  // MUTANTS: no note; a note for an empty session too; the note added where
  // the auto-resume pick runs (demote and release checks call it), so it
  // repeats.
  it("at boot: a missing session leaves one note that the first fresh turn keeps, an empty one leaves none; both are logged", async () => {
    const fake = new ProfileStoreBackend();
    const key = environmentSourceKeyForUserId(null);
    fake.put(key, "ses_blank", "empty");
    const mgr = restoringManager(fake, "room-unresumable", [
      persisted("agent-missing", "ses_gone", null),
      { ...persisted("agent-empty", "ses_blank", null), desk: 1 },
    ]);
    const lines = await consoleLines(async () => {
      await mgr.restoreAgents();
    });
    expect(mgr.getCurrentSessionId("agent-missing")).toBeNull();
    expect(mgr.getCurrentSessionId("agent-empty")).toBeNull();

    const notes = extraSystemEntries(
      mgr.getAgentLogs("agent-missing"),
      mgr.getAgentLogs("agent-empty"),
    );
    expect(notes).toHaveLength(1);
    expect(
      extraSystemEntries(
        mgr.getAgentLogs("agent-empty"),
        mgr.getAgentLogs("agent-missing"),
      ),
    ).toEqual([]);
    for (const [agentId, sessionId] of [
      ["agent-missing", "ses_gone"],
      ["agent-empty", "ses_blank"],
    ])
      expect(
        lines.some(
          (line) => line.includes(agentId) && line.includes(sessionId),
        ),
        `a log line names ${agentId} and ${sessionId}`,
      ).toBe(true);

    await turn(mgr, "agent-missing", "fresh start");
    expect(
      mgr.getAgentLogs("agent-missing").map((entry) => entry.id),
    ).toContain(notes[0].id);
    expect(fake.resumeSessionCount).toBe(0);
    fake.sessions.forEach((session) => session.close());
  });

  it("on the next message: a missing session leaves one note in the new conversation, an empty one leaves none; both are logged", async () => {
    const fake = new ProfileStoreBackend();
    const mgr = spawningManager(fake, "room-next-message");
    const missing = await spawnOpenCode(
      mgr,
      "room-next-message",
      null,
      "Missing",
    );
    const empty = await spawnOpenCode(mgr, "room-next-message", null, "Empty");
    const key = environmentSourceKeyForUserId(null);
    const ended: Record<string, string> = {};
    for (const agentId of [missing, empty]) {
      await turn(mgr, agentId, `first ${agentId}`);
      expect(await mgr.demoteToLazy(agentId)).toBe(true);
      ended[agentId] = mgr.getCurrentSessionId(agentId)!;
    }
    fake.stored.get(key)!.delete(ended[missing]);
    fake.put(key, ended[empty], "empty");

    const lines = await consoleLines(async () => {
      await turn(mgr, missing, "second missing");
      await turn(mgr, empty, "second empty");
    });
    expect(mgr.getCurrentSessionId(missing)).not.toBe(ended[missing]);
    expect(mgr.getCurrentSessionId(empty)).not.toBe(ended[empty]);
    expect(fake.resumeSessionCount).toBe(0);
    expect(
      extraSystemEntries(mgr.getAgentLogs(missing), mgr.getAgentLogs(empty)),
    ).toHaveLength(1);
    expect(
      extraSystemEntries(mgr.getAgentLogs(empty), mgr.getAgentLogs(missing)),
    ).toEqual([]);
    for (const agentId of [missing, empty])
      expect(
        lines.some(
          (line) => line.includes(agentId) && line.includes(ended[agentId]),
        ),
        `a log line names ${agentId} and its session`,
      ).toBe(true);
    fake.sessions.forEach((session) => session.close());
  });
});

describe("an explicit resume of a session from another profile", () => {
  // MUTANT: recover any id the request names. Other members' profiles are in
  // the search, so the agent's own session list is the ownership proof.
  it("recovers a missing session the agent owns, and never one it does not own", async () => {
    const fake = new ProfileStoreBackend();
    const mgr = spawningManager(fake, "room-explicit");
    const agentId = await spawnOpenCode(mgr, "room-explicit", null);
    await turn(mgr, agentId, "first");
    const current = mgr.getCurrentSessionId(agentId)!;
    const key = environmentSourceKeyForUserId(null);
    // An older conversation of this agent, stored in another profile: its
    // transcript and its entry are in the agent's session list.
    appendLog(agentId, "ses_old", {
      id: "log-old",
      agentId,
      timestamp: Date.now() - 60_000,
      kind: "user_message",
      content: "an older conversation",
    });
    persistSessionCwd(agentId, "ses_old", STATE_ROOT);
    fake.elsewhere.add("ses_old");
    // Another agent's conversation, also in another profile.
    fake.elsewhere.add("ses_foreign");

    await mgr.resume(agentId, "ses_old");
    expect(fake.recoverCalls).toEqual([
      { sessionId: "ses_old", environmentKey: key },
    ]);
    expect(mgr.getCurrentSessionId(agentId)).toBe("ses_old");
    expect(fake.lastSession?.isResume).toBe(true);
    expect(fake.lastSession?.sessionId).toBe("ses_old");

    await mgr.resume(agentId, "ses_foreign");
    expect(fake.recoverCalls).toHaveLength(1);
    expect(mgr.getCurrentSessionId(agentId)).not.toBe("ses_foreign");

    // A stored session needs no recovery.
    await mgr.resume(agentId, current);
    expect(fake.recoverCalls).toHaveLength(1);
    expect(mgr.getCurrentSessionId(agentId)).toBe(current);
    fake.sessions.forEach((session) => session.close());
  });
});
