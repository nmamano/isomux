// The orchestrator records a Claude session's claude.ai connectors from its
// init and from the status read after each turn, against the sign-in the
// session was LAUNCHED with, and only for a claude.ai login.
import { afterEach, describe, expect, it } from "bun:test";

import { OfficeState } from "../../shared/office-state.ts";
import type { AgentBackendType, RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import { getAgentHost } from "../agent-host.ts";
import { claudeConfigRoot } from "../claude-session-root.ts";
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
import {
  claudeConnectorsFor,
  resetClaudeConnectorsForTests,
} from "../claude-connectors.ts";
import { FakeBackend } from "./fake-backend.ts";

const USER = "user-connectors";

afterEach(() => {
  resetClaudeConnectorsForTests();
  removeManagedUserEnv(USER);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label = "cond"): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function room(): RoomWire[] {
  return [
    { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
  ];
}

type Server = { name: string; status?: string; source?: string };
const gmail: Server = {
  name: "claude.ai Gmail",
  status: "pending",
  source: "claudeai",
};
const drive: Server = {
  name: "claude.ai Drive",
  status: "connected",
  source: "claudeai",
};

const MARKER = "init handled";

const currentDir = () =>
  claudeConfigRoot(buildEnvForUserId(USER) ?? getAgentHost().baseEnv());

// Spawn an agent, let it launch its session, then (optionally) change the
// member's env, deliver an init, and (optionally) finish the turn with a
// status read. Returns the directory the session launched with.
async function runSession(opts: {
  agentType?: AgentBackendType;
  init?: { mcpServers?: Server[]; apiKeySource?: string };
  envAfterLaunch?: Record<string, string>;
  afterTurn?: Server[];
}): Promise<{ launchDir: string; statusReads: number }> {
  const fake = new FakeBackend();
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: room() }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    "Worker",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
    undefined,
    undefined,
    undefined,
    "Owner",
    opts.agentType ?? "claude",
    undefined,
    USER,
  );
  if (!info) throw new Error("spawn returned null");
  mgr.enqueueMessage(info.id, {
    sender: { kind: "user", username: "Boss" },
    text: "hi",
  });
  await waitUntil(
    () => fake.sessionForAgent(info.id) !== undefined,
    "session created",
  );
  const launchDir = currentDir();
  if (opts.envAfterLaunch) writeManagedUserEnv(USER, opts.envAfterLaunch);
  const session = fake.sessionForAgent(info.id)!;
  session.push({
    kind: "system_init",
    sessionId: "s-connectors",
    slashCommands: [],
    apiKeySource: "none",
    mcpServers: [gmail],
    ...opts.init,
  });
  session.push({ kind: "system_text", text: MARKER });
  await waitUntil(
    () => mgr.getAgentLogs(info.id).some((e) => e.content === MARKER),
    "events handled",
  );
  let statusReads = 0;
  if (opts.afterTurn) {
    const servers = opts.afterTurn;
    (
      session as unknown as { getMcpServers: () => Promise<Server[]> }
    ).getMcpServers = async () => {
      statusReads++;
      return servers;
    };
    session.completeTurn({ text: "done" });
    await waitUntil(() => statusReads > 0, "status read");
    // Let the read's continuation run.
    await sleep(20);
  }
  return { launchDir, statusReads };
}

describe("claude.ai connectors from a running session", () => {
  it("records a Claude session's connectors against its launched sign-in", async () => {
    const { launchDir } = await runSession({});
    expect(claudeConnectorsFor(launchDir)?.names).toEqual(["Gmail"]);
  });

  it("replaces the list with the status read after the turn", async () => {
    const { launchDir, statusReads } = await runSession({ afterTurn: [drive] });
    expect(statusReads).toBe(1);
    expect(claudeConnectorsFor(launchDir)?.names).toEqual(["Drive"]);
  });

  it("keys on the directory the session launched with, not the member's current one", async () => {
    writeManagedUserEnv(USER, {
      CLAUDE_CONFIG_DIR: "/tmp/connectors-launch-claude",
    });
    const { launchDir, statusReads } = await runSession({
      envAfterLaunch: { CLAUDE_CONFIG_DIR: "/tmp/connectors-later-claude" },
      afterTurn: [drive],
    });
    // The member's env really moved between launch and init.
    expect(launchDir).toBe("/tmp/connectors-launch-claude");
    expect(currentDir()).toBe("/tmp/connectors-later-claude");
    expect(statusReads).toBe(1);
    expect(claudeConnectorsFor(launchDir)?.names).toEqual(["Drive"]);
    expect(claudeConnectorsFor("/tmp/connectors-later-claude")).toBeNull();
  });

  it("records nothing from a session launched on Bedrock", async () => {
    writeManagedUserEnv(USER, { CLAUDE_CODE_USE_BEDROCK: "1" });
    // The launch env really selects Bedrock.
    expect(buildEnvForUserId(USER)?.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    const { launchDir, statusReads } = await runSession({ afterTurn: [drive] });
    expect(statusReads).toBe(1);
    expect(claudeConnectorsFor(launchDir)).toBeNull();
  });

  it("records nothing from a session that bills an API key, at init or after the turn", async () => {
    const { launchDir, statusReads } = await runSession({
      init: { apiKeySource: "ANTHROPIC_API_KEY", mcpServers: [gmail] },
      afterTurn: [drive],
    });
    // The status read really ran.
    expect(statusReads).toBe(1);
    expect(claudeConnectorsFor(launchDir)).toBeNull();
  });

  it("records nothing for another engine", async () => {
    const { launchDir } = await runSession({ agentType: "codex" });
    expect(claudeConnectorsFor(launchDir)).toBeNull();
  });
});
