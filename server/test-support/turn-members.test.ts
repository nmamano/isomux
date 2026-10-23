// Who a turn belongs to (task 10d7ead6): a member's skill and a member's edit
// start a turn that is that member's (AgentInfo.turnMemberIds), as a direct
// send does. The queue and the usage-limit resume are pinned in
// queue.test.ts and limit-resume.test.ts. An agent's turn in between flips
// the list to [], so no case is pre-satisfied by the turn before it.
//
// Seam: the DI manager (createAgentManager + FakeBackend), the
// edit-interrupted.test.ts idiom. Zero LLM calls.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { loadLog } from "../persistence.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { FakeBackend } from "./fake-backend.ts";
import { createMember, getUserByName } from "../users.ts";

const PARENT_SID = "fake-session-1";
const FORK_SID = "forked-1";
const OTHER = {
  kind: "agent" as const,
  agentId: "agent-other",
  agentName: "Other",
  roomName: "room-a",
};

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

// The user store outlives the state dir reset in a multi-file run, so an
// earlier file may have made Morgan already.
function morganId(): string {
  const known = getUserByName("Morgan");
  if (known) return known.id;
  const created = createMember("Morgan", { role: "owner" });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}

async function setup() {
  const claudeHome = join(STATE_ROOT, "claude-home");
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
  const fake = new FakeBackend({
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "reply" }) },
    forkResult: {
      kind: "fork",
      sessionId: FORK_SID,
      forkedFromSessionId: PARENT_SID,
    },
    sessionMessages: [
      { uuid: "u-0", role: "user" as const, text: "[Morgan] first" },
      { uuid: "a-0", role: "assistant" as const, text: "reply" },
    ],
  });
  activeFakes.push(fake);
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({
      rooms: [{ id: "room-a", name: "room-a", prompt: null }],
    }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  const info = (await mgr.spawn(
    "A",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
  ))!;
  const forkDir = claudeProjectDir(info.cwd, { CLAUDE_CONFIG_DIR: claudeHome });
  mkdirSync(forkDir, { recursive: true });
  writeFileSync(join(forkDir, `${FORK_SID}.jsonl`), "");
  // Runs one turn to its end and returns its members.
  let turns = 0;
  const turn = async (label: string, start: () => unknown) => {
    turns += 1;
    const n = turns;
    void start();
    await waitUntil(
      () =>
        fake.sessions.reduce((sum, s) => sum + s.sent.length, 0) === n &&
        mgr.getAgent(info.id)?.state === "waiting_for_response",
      label,
    );
    return mgr.getAgent(info.id)?.turnMemberIds;
  };
  const agentTurn = () =>
    turn("agent turn", () =>
      mgr.enqueueMessage(info.id, { sender: OTHER, text: "ping" }),
    );
  return { mgr, info, turn, agentTurn };
}

describe("turnMemberIds: a member's skill and edit", () => {
  it("a skill a member runs is that member's turn", async () => {
    const id = morganId();
    const skillDir = join(STATE_ROOT, "skills", "memberskill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "SKILL-BODY: do the thing.");
    const { mgr, info, turn, agentTurn } = await setup();
    expect(await agentTurn()).toEqual([]);
    expect(
      await turn("skill", () =>
        mgr.sendMessage(info.id, "/memberskill", "Morgan"),
      ),
    ).toEqual([id]);
  });

  it("an edit a member makes is that member's turn", async () => {
    const id = morganId();
    const { mgr, info, turn, agentTurn } = await setup();
    expect(
      await turn("first", () => mgr.sendMessage(info.id, "first", "Morgan")),
    ).toEqual([id]);
    expect(await agentTurn()).toEqual([]);
    const firstId = loadLog(info.id, PARENT_SID).find(
      (e) => e.kind === "user_message" && e.content === "first",
    )!.id;
    expect(
      await turn("edit", () =>
        mgr.editMessage(info.id, firstId, "first, fixed", "Morgan"),
      ),
    ).toEqual([id]);
  });
});
