// The orchestrator records a Claude session's claude.ai connectors from its
// init and from the status read after each turn, against the sign-in the
// session was LAUNCHED with, and only for a claude.ai login.
import { afterEach, describe, expect, it } from "bun:test";

import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import { getAgentHost } from "../agent-host.ts";
import { claudeConfigRoot } from "../claude-session-root.ts";
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
import {
  claudeConnectorStatusesFor,
  claudeConnectorsFor,
  claudeEngineServersFor,
  resetClaudeConnectorsForTests,
  resetClaudeEngineServersForTests,
} from "../claude-connectors.ts";
import { FakeBackend } from "./fake-backend.ts";

const USER = "user-connectors";

afterEach(() => {
  resetClaudeConnectorsForTests();
  resetClaudeEngineServersForTests();
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

// What one status read answers: a list, or a function that answers it later.
type Read = Server[] | (() => Promise<Server[]>);

const REREAD_MS = 30;

// Spawn an agent, let it launch its session, then (optionally) change the
// member's env, deliver an init, and (optionally) finish the turn with a
// status read. Returns the directory the session launched with. With
// `reads`, the status reads answer each in turn (the last one repeats).
async function runSession(opts: {
  init?: { mcpServers?: Server[]; apiKeySource?: string };
  envAfterLaunch?: Record<string, string>;
  afterTurn?: Server[];
  reads?: Read[];
}) {
  const fake = new FakeBackend();
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: room() }),
    initialRooms: [],
    connectorRereadMs: REREAD_MS,
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
    "claude",
    undefined,
    USER,
  );
  if (!info) throw new Error("spawn returned null");
  mgr.enqueueMessage(info.id, {
    sender: { kind: "user", username: "Morgan" },
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
  const reads = opts.reads ?? (opts.afterTurn ? [opts.afterTurn] : null);
  if (reads) {
    (
      session as unknown as { getMcpServers: () => Promise<Server[]> }
    ).getMcpServers = async () => {
      const read = reads[Math.min(statusReads, reads.length - 1)];
      statusReads++;
      return typeof read === "function" ? read() : read;
    };
    session.completeTurn({ text: "done" });
    await waitUntil(() => statusReads > 0, "status read");
    // Let the read's continuation run.
    await sleep(20);
  }
  return {
    launchDir,
    statusReads,
    readCount: () => statusReads,
    mgr,
    agentId: info.id,
    session,
  };
}

describe("claude.ai connectors from a running session", () => {
  it("records a Claude session's connectors against its launched sign-in", async () => {
    const { launchDir } = await runSession({});
    expect(claudeConnectorsFor(launchDir)?.names).toEqual(["Gmail"]);
  });

  it("keys on the directory the session launched with, not the member's current one", async () => {
    writeManagedUserEnv(USER, {
      CLAUDE_CONFIG_DIR: "/tmp/connectors-launch-claude",
    });
    const { launchDir, statusReads, agentId } = await runSession({
      envAfterLaunch: { CLAUDE_CONFIG_DIR: "/tmp/connectors-later-claude" },
      afterTurn: [
        drive,
        { name: "notes", status: "connected", source: "user" },
      ],
    });
    // The member's env really moved between launch and init.
    expect(launchDir).toBe("/tmp/connectors-launch-claude");
    expect(currentDir()).toBe("/tmp/connectors-later-claude");
    expect(statusReads).toBe(1);
    expect(claudeConnectorsFor(launchDir)?.names).toEqual(["Drive"]);
    expect(claudeConnectorsFor("/tmp/connectors-later-claude")).toBeNull();
    // A server set in Claude user settings lives in the launch directory too.
    expect(
      claudeEngineServersFor([agentId], (dir) =>
        dir === launchDir ? "personal" : null,
      ).map((row) => row.signIn),
    ).toEqual(["personal"]);
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
});

// A read right after a short turn can see "pending": MCP servers are still
// connecting for some seconds after a session starts (probe, 2026-10-13).
describe("a status read that sees pending", () => {
  const connected: Server = { ...gmail, status: "connected" };
  const notes: Server = { name: "notes", status: "pending", source: "user" };
  const notesConnected: Server = { ...notes, status: "connected" };
  // Long enough for a chain that did not stop to read again.
  const settle = () => sleep(REREAD_MS * 6);

  // A read that waits until the test releases it.
  function heldRead(servers: Server[]) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    return {
      read: async () => {
        await held;
        return servers;
      },
      release,
    };
  }

  it("reads again and records the later status", async () => {
    const { launchDir, readCount } = await runSession({
      reads: [[gmail], [connected]],
    });
    await waitUntil(() => readCount() === 2, "second read");
    await settle();
    expect(readCount()).toBe(2);
    expect(claudeConnectorStatusesFor(launchDir)).toEqual([
      { name: "Gmail", status: "connected" },
    ]);
  });

  it("reads again for a server set in Claude", async () => {
    const { agentId, readCount } = await runSession({
      reads: [[notes], [notesConnected]],
    });
    await waitUntil(() => readCount() === 2, "second read");
    await settle();
    expect(readCount()).toBe(2);
    expect(claudeEngineServersFor([agentId])).toEqual([
      expect.objectContaining({ name: "notes", status: "connected" }),
    ]);
  });

  it("reads once when nothing is pending", async () => {
    const { launchDir, readCount } = await runSession({ reads: [[connected]] });
    await settle();
    expect(readCount()).toBe(1);
    expect(claudeConnectorStatusesFor(launchDir)).toEqual([
      { name: "Gmail", status: "connected" },
    ]);
  });

  it("stops after three reads", async () => {
    const { launchDir, readCount } = await runSession({ reads: [[gmail]] });
    await waitUntil(() => readCount() === 3, "third read");
    await settle();
    expect(readCount()).toBe(3);
    expect(claudeConnectorStatusesFor(launchDir)).toEqual([
      { name: "Gmail", status: "pending" },
    ]);
  });

  it("stops when the agent's next turn starts", async () => {
    // The first read sees pending only after the next turn has started.
    const first = heldRead([gmail]);
    const { readCount, mgr, agentId } = await runSession({
      reads: [first.read, [connected]],
    });
    mgr.enqueueMessage(agentId, {
      sender: { kind: "user", username: "Morgan" },
      text: "next",
    });
    await waitUntil(
      () => mgr.getAgent(agentId)?.state === "thinking",
      "next turn started",
    );
    first.release();
    await settle();
    expect(readCount()).toBe(1);
  });

  it("records nothing from a read that lands after a new conversation", async () => {
    const second = heldRead([connected]);
    const { launchDir, readCount, mgr, agentId } = await runSession({
      reads: [[gmail], second.read],
    });
    await waitUntil(() => readCount() === 2, "second read started");
    await mgr.newConversation(agentId);
    second.release();
    await settle();
    expect(readCount()).toBe(2);
    expect(claudeConnectorStatusesFor(launchDir)).toEqual([
      { name: "Gmail", status: "pending" },
    ]);
  });

  it("does not put a killed agent's servers back", async () => {
    const second = heldRead([connected, notesConnected]);
    const { launchDir, readCount, mgr, agentId } = await runSession({
      reads: [[gmail, notes], second.read],
    });
    expect(claudeEngineServersFor([agentId])).toHaveLength(1);
    await waitUntil(() => readCount() === 2, "second read started");
    await mgr.kill(agentId);
    second.release();
    await settle();
    expect(readCount()).toBe(2);
    expect(claudeEngineServersFor([agentId])).toEqual([]);
    expect(claudeConnectorStatusesFor(launchDir)).toEqual([
      { name: "Gmail", status: "pending" },
    ]);
  });
});
