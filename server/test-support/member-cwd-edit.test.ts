// The folder change of an isolated member's Claude agent that has a
// conversation (task 6dbd3d4f). The member's runner moves the transcript and,
// when it moved nothing, the edit asks whether the transcript is already at
// the target. The properties: that question goes to the member's host, never
// to the office's files; an edit that is refused (a host that cannot
// answer) leaves the agent's folder and the session's stamp both at the old
// folder, and names the folders. Since task 3a2de351 the member's runner is
// first asked to put the transcript back from the member's own store, and
// a transcript at neither end applies the folder and starts a new
// conversation.
//
// The member host's fs here answers `exists` only from `present`, so a check
// that read the office's disk, or asked about the wrong path, shows red.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { localAgentFs, type AgentFs } from "../agent-host.ts";
import { createAgentManager } from "../agent-manager.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import {
  getSessionCwd,
  persistSessionCwd,
  type PersistedAgent,
} from "../persistence.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { createMember, deleteUserById } from "../users.ts";
import { claudeBackend } from "../backends/claude.ts";
import { FakeBackend } from "./fake-backend.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

const SESSION = "6dbd3d4f-0a1b-4c2d-8e3f-405162738495";

let iso: IsolatedMember;
let alice: string;
let scratch: string;
let oldCwd: string;
let newCwd: string;
// Paths the member host's exists() answers true for.
let present: Set<string>;
// Paths the member host's exists() was asked about.
let asked: string[];
// When set, the member host's exists() rejects with it.
let existsFails: Error | null;
// The claude-cwd-move entries the member's runner got.
let moves: Record<string, unknown>[];
// The engine-session-prepare entries the member's runner got.
let prepares: Record<string, unknown>[];

beforeEach(async () => {
  const made = createMember(`CwdAlice${crypto.randomUUID().slice(0, 8)}`, {
    role: "member",
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.user.id;
  iso = await isolateMember(alice);
  scratch = mkdtempSync(join(tmpdir(), "member-cwd-edit-"));
  oldCwd = join(scratch, "old");
  newCwd = join(scratch, "new");
  await localAgentFs.mkdir(oldCwd, 0o700);
  await localAgentFs.mkdir(newCwd, 0o700);
  present = new Set();
  asked = [];
  existsFails = null;
  moves = [];
  prepares = [];
  const fs: AgentFs = {
    ...localAgentFs,
    exists: async (path) => {
      asked.push(path);
      if (existsFails) throw existsFails;
      return present.has(path);
    },
  };
  (iso.member.host as { fs: AgentFs }).fs = fs;
  // The member's runner: the old folder holds no transcript, so it moves
  // nothing and says so (the shape of a real claude-cwd-move answer).
  (iso.member.host as { runEntry: unknown }).runEntry = async (
    name: string,
    input: Record<string, unknown>,
  ) => {
    if (name === "engine-session-prepare") {
      prepares.push(input);
      return { restored: 0, touched: 0 };
    }
    if (name !== "claude-cwd-move") throw new Error(`unexpected ${name}`);
    moves.push(input);
    return { ok: true, moved: false };
  };
});

afterEach(() => {
  iso.dispose();
  rmSync(scratch, { recursive: true, force: true });
  deleteUserById(alice);
});

// A restored member agent whose conversation is not running (session null,
// session id set), stamped in the old folder.
async function memberAgent() {
  const persisted = {
    id: `member-cwd-edit-${crypto.randomUUID()}`,
    name: "Member cwd edit",
    desk: 0,
    cwd: oldCwd,
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
    modelFamily: "sonnet",
    effort: "high",
    agentType: "claude",
    lastSessionId: SESSION,
    topic: null,
    customInstructions: null,
    userId: alice,
    username: null,
  } as unknown as PersistedAgent;
  const mgr = createAgentManager({
    resolveBackend: () =>
      Object.assign(new FakeBackend({ storedSessionState: "durable" }), {
        sessionFiles: claudeBackend.sessionFiles,
      }),
    officeState: new OfficeState({
      rooms: [{ id: "room-cwd-edit", name: "room-cwd-edit", prompt: null }],
    }),
    initialRooms: [
      {
        id: "room-cwd-edit",
        name: "room-cwd-edit",
        prompt: null,
        agents: [persisted],
      },
    ],
  });
  await mgr.restoreAgents();
  const agentId = persisted.id;
  persistSessionCwd(agentId, SESSION, oldCwd);
  // The case needs the conversation in the old folder and not running.
  expect(mgr.getCurrentSessionId(agentId)).toBe(SESSION);
  expect(mgr.getAgent(agentId)?.cwd).toBe(oldCwd);
  expect(getSessionCwd(agentId, SESSION)).toBe(oldCwd);
  return { mgr, agentId };
}

// The transcript path at `cwd` under the member's Claude root.
function transcriptAt(cwd: string): string {
  return join(
    claudeProjectDir(cwd, buildEnvForUserId(alice)!),
    `${SESSION}.jsonl`,
  );
}

async function editFailure(
  mgr: Awaited<ReturnType<typeof memberAgent>>["mgr"],
  agentId: string,
): Promise<Error> {
  const failure = await mgr.editAgent(agentId, { cwd: newCwd }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  return failure as Error;
}

describe("an isolated member's Claude agent with a conversation changes folder", () => {
  it("goes through when the runner moved nothing and the member's host has the transcript at the target", async () => {
    const { mgr, agentId } = await memberAgent();
    present.add(transcriptAt(newCwd));
    await mgr.editAgent(agentId, { cwd: newCwd });
    // The runner was asked to move, and moved nothing: the edit went on
    // only because the member's host has the transcript at the target.
    expect(moves.map((m) => [m.oldCwd, m.newCwd])).toEqual([[oldCwd, newCwd]]);
    expect(asked).toContain(transcriptAt(newCwd));
    expect({
      mirror: mgr.getAgent(agentId)?.cwd,
      stamp: getSessionCwd(agentId, SESSION),
    }).toEqual({ mirror: newCwd, stamp: newCwd });
  });

  // MUTANTS: the put-back run on the office host (the office cannot link a
  // member's file: protected_hardlinks) or with the office's agent root
  // (the member's store is in their own agent space); no put-back before
  // the move; the old refusal kept; the session id kept.
  it("asks the member's runner to put the transcript back from the member's store, then applies the folder and starts fresh when it is at neither end", async () => {
    const { mgr, agentId } = await memberAgent();
    await mgr.editAgent(agentId, { cwd: newCwd });
    expect(prepares).toHaveLength(1);
    expect(prepares[0].root).toBe(
      claudeProjectDir(oldCwd, buildEnvForUserId(alice)!),
    );
    expect(prepares[0].store).toBe(
      join(iso.member.host.agentRoot(), "engine-sessions", agentId, SESSION),
    );
    // The member's host was asked, and said no.
    expect(asked).toContain(transcriptAt(newCwd));
    expect({
      mirror: mgr.getAgent(agentId)?.cwd,
      session: mgr.getCurrentSessionId(agentId),
    }).toEqual({ mirror: newCwd, session: null });
  });

  it("is refused with nothing changed when the member's host cannot answer", async () => {
    const { mgr, agentId } = await memberAgent();
    present.add(transcriptAt(newCwd));
    existsFails = new Error("the agent runner did not answer exists");
    const failure = await editFailure(mgr, agentId);
    // The failure came from the member's host, not from a check before it.
    expect(asked).toContain(transcriptAt(newCwd));
    expect({
      mirror: mgr.getAgent(agentId)?.cwd,
      stamp: getSessionCwd(agentId, SESSION),
    }).toEqual({ mirror: oldCwd, stamp: oldCwd });
    // A refusal the member can act on names the folders.
    expect(failure.message).toContain(oldCwd);
    expect(failure.message).toContain(newCwd);
  });
});
