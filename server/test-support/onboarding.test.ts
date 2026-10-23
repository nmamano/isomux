// Phase 1.1 - Flagship onboarding / fresh-install characterization.
//
// Freezes the observable contract of the welcome-agent seed across the three
// backend-availability states a brand-new office can be in. This is the first
// REAL characterization test on the 0.3 harness (harness.test.ts stays a thin
// smoke proving the harness itself); the richer projection/ACL and persistence
// nets are 1.2 / 1.3.
//
// How the seed is exercised (NOT via harness.seedOwner): the three-agent
// welcome seed fires from the onOwnerCreated hook on the HTTP claim path. We go
// through a real POST /auth/claim so the hook runs; seedOwner() calls
// _testSeedOwner directly and bypasses it.
//
// Backend states are scripted on a single injected FakeBackend. The harness
// resolver is `() => fakeBackend` and ignores agentType, so ONE fake drives all
// welcome agents (incl. detectAuthError + getLoginInstructions). Spawn creates a
// session synchronously but never auto-sends; every normal/error behavior here
// surfaces on the FIRST user message, so each state is driven by a WS
// the message endpoint and observed on the wire (log_entry) plus in-memory state.
//
// The first user message also kicks off fire-and-forget topic generation
// (oneShotPrompt); the fake resolves it synchronously so its tail settles before
// teardown.
//
// Zero LLM calls: bun test. The opt-in T3 live logged-in happy path is deferred
// to Phase 1.4 (where the live/adapter infra lands); see live-gate.ts.

import { sessionCookieName } from "../auth.ts";
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { BackendNotConfiguredError } from "../internal-types.ts";
import { STATE_ROOT } from "../config.ts";
import { listAgentSessions } from "../persistence.ts";
import { getUserByName } from "../users.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";
import { MODEL_FAMILIES } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Real owner claim with the setup key over HTTP. Returns the minted session
// cookie. The claim AWAITS onOwnerCreated, so by the time this resolves both
// welcome agents are already spawned into officeState.
async function claimOwner(srv: TestServer, name: string): Promise<string> {
  const res = await srv.http("/auth/claim", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `name=${encodeURIComponent(name)}&key=${encodeURIComponent(srv.setupKey())}`,
    redirect: "manual",
  });
  if (res.status !== 302) throw new Error(`claim failed: HTTP ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(
    new RegExp(`${sessionCookieName()}=([^;]+)`),
  );
  if (!m) throw new Error("claim: no session cookie set");
  return m[1];
}

async function connectAsOwner(
  srv: TestServer,
  rawSessionId: string,
): Promise<TestSocket> {
  const sock = await srv.connectWs(rawSessionId);
  // Block until the connect handshake's projected snapshot has arrived so the
  // socket is fully live before we drive a turn.
  await sock.waitFor("full_state");
  return sock;
}

// Content-matching waiters. The harness's TestSocket.waitFor matches on message
// TYPE only; onboarding needs to match on log-entry CONTENT + agentId, so these
// poll the socket's own buffered messages instead.
//
// All log_entry events seen on this socket FOR a specific agent. Scoping by
// agentId is load-bearing: both welcome agents share the fake and the connect
// handshake replays each one's "Agent ... ready" system log, so an unscoped
// match would collide with the other agent's startup noise.
function logEntriesFor(sock: TestSocket, agentId: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const m of sock.messages) {
    const msg = m as { type?: string; entry?: LogEntry };
    if (msg.type === "log_entry" && msg.entry?.agentId === agentId) {
      out.push(msg.entry);
    }
  }
  return out;
}

// Poll the socket's buffered log_entry events until one matches. Order-tolerant
// on purpose (per review: assert the observable shape, not a brittle total order
// - topic generation interleaves its own events on the first message).
async function waitForLog(
  sock: TestSocket,
  agentId: string,
  pred: (e: LogEntry) => boolean,
  timeoutMs = 2000,
): Promise<LogEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = logEntriesFor(sock, agentId).find(pred);
    if (found) return found;
    if (Date.now() > deadline) {
      const kinds = logEntriesFor(sock, agentId)
        .map((e) => e.kind)
        .join(", ");
      throw new Error(
        `waitForLog timed out for ${agentId}; saw kinds: [${kinds}]`,
      );
    }
    await sleep(10);
  }
}

// In-memory state is the natural read for the convergent agent state; the
// distinguishing signal between the three states is the log content above, not
// the final state (all three converge on waiting_for_response).
async function waitForState(
  srv: TestServer,
  agentId: string,
  state: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (srv.agentManager.getAgent(agentId)?.state === state) return;
    if (Date.now() > deadline) {
      const actual = srv.agentManager.getAgent(agentId)?.state;
      throw new Error(
        `waitForState timed out: ${agentId} is "${actual}", wanted "${state}"`,
      );
    }
    await sleep(10);
  }
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`waitUntil timed out: ${description}`);
    await sleep(10);
  }
}

// agents.json is JSON.stringify(Room[]) where each room carries .agents (the
// current pre-flatten shape; 1.3's stable-room-ids migration changes it, at
// which point this characterization updates with it).
function persistedAgentRecords(): Array<{
  name?: string;
  agentType?: string;
  modelFamily?: string;
  permissionMode?: string;
}> {
  const path = join(STATE_ROOT, "agents.json");
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ name?: string }> = [];
  for (const room of parsed) {
    const agents = (room as { agents?: unknown[] })?.agents;
    if (Array.isArray(agents))
      out.push(...(agents as Array<{ name?: string }>));
  }
  return out;
}

const CLAUDE_WELCOME = "Claude Welcome Agent";
const CODEX_WELCOME = "Codex Welcome Agent";
const OPENCODE_WELCOME = "Free Welcome Agent";

// Resolve a seeded welcome agent by name, failing clearly (vs a bare non-null
// assertion's generic throw) if the seed ever regresses.
function requireAgentByName(srv: TestServer, name: string): AgentInfo {
  const agent = srv.agentManager.getAllAgents().find((a) => a.name === name);
  expect(agent).toBeDefined();
  return agent as AgentInfo;
}

describe("onboarding / fresh install (Phase 1.1)", () => {
  it("seeds Claude, Codex, and free-model OpenCode welcome agents on the first-owner claim", async () => {
    // Default harness backend; the seed never sends, so its onSend is irrelevant.
    server = await startTestServer();
    await claimOwner(server, "Morgan");

    const agents = server.agentManager.getAllAgents();
    // Three welcome agents plus the receptionist (receptionist.test.ts).
    expect(agents.length).toBe(4);

    const claude = agents.find((a) => a.name === CLAUDE_WELCOME);
    const codex = agents.find((a) => a.name === CODEX_WELCOME);
    const opencode = agents.find((a) => a.name === OPENCODE_WELCOME);
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();
    expect(opencode).toBeDefined();

    // Backend + model + permission identity each welcome agent ships with.
    expect(claude!.agentType).toBe("claude");
    expect(claude!.modelFamily).toBe("opus");
    expect(claude!.permissionMode).toBe("auto");
    expect(codex!.agentType).toBe("codex");
    expect(codex!.modelFamily).toBe("gpt-6.1-sol");
    expect(codex!.permissionMode).toBe("never");
    expect(codex!.codexSandbox).toBe("danger-full-access");
    expect(opencode!.agentType).toBe("opencode");
    expect(opencode!.modelFamily).toBe(
      "opencode/muse-spark-1.2-contributor-free",
    );
    expect(opencode!.permissionMode).toBe("bypassPermissions");

    // Lazy spawn: the welcome agents are seeded DORMANT - zero subprocesses
    // until someone messages them (a fresh-install office shouldn't burn ~330MB
    // on three agents nobody has talked to yet).
    expect(server.fakeBackend.createSessionCount).toBe(0);
    expect(claude!.dormant).toBe(true);
    expect(codex!.dormant).toBe(true);
    expect(opencode!.dormant).toBe(true);

    // Each welcome agent's instructions name the whole roster.
    for (const agent of agents.filter((a) => a.roomId !== "lobby")) {
      for (const name of [CLAUDE_WELCOME, CODEX_WELCOME, OPENCODE_WELCOME])
        expect(agent.customInstructions).toContain(name);
    }

    // Persisted to disk under the temp STATE_ROOT (parse records, not substring).
    const names = persistedAgentRecords().map((a) => a.name);
    expect(names).toContain(CLAUDE_WELCOME);
    expect(names).toContain(CODEX_WELCOME);
    expect(names).toContain(OPENCODE_WELCOME);
  });

  it("seeds the Codex welcome agent on the owner's discovered default model (task 141beeb6)", async () => {
    const calls: string[] = [];
    server = await startTestServer({
      startServer: {
        listCodexModels: async ({ userId }) => {
          calls.push(userId);
          return [
            { id: "gpt-6.1-sol", label: "Static", supportedEfforts: [] },
            {
              id: "gpt-login-default",
              label: "Login default",
              isDefault: true,
              supportedEfforts: [],
            },
          ];
        },
      },
    });
    await claimOwner(server, "Morgan");
    expect(requireAgentByName(server, CODEX_WELCOME).modelFamily).toBe(
      "gpt-login-default",
    );
    expect(calls).toEqual([getUserByName("Morgan")!.id]);
  });

  it("leaves an office that already has an agent unchanged on first-owner claim", async () => {
    server = await startTestServer();
    const existing = await server.agentManager.spawn(
      "Existing Agent",
      "~",
      "auto",
    );
    expect(existing).not.toBeNull();

    await claimOwner(server, "Morgan");

    // No welcome agents; the receptionist joins any office that gets an owner.
    const agents = server.agentManager
      .getAllAgents()
      .filter((a) => a.roomId !== "lobby");
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(existing!.id);
    expect(agents[0].name).toBe("Existing Agent");
  });

  it("persists a topic that resolves before a fresh OpenCode session id", async () => {
    const fakeBackend = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
      oneShot: "Resolved topic",
    });
    server = await startTestServer({ fakeBackend });
    const rawSessionId = await claimOwner(server, "Morgan");
    const opencode = requireAgentByName(server, OPENCODE_WELCOME);

    await server.http(`/api/agents/${opencode.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "first request" }),
      rawSessionId,
    });

    await waitUntil(
      () =>
        listAgentSessions(opencode.id).some(
          (session) => session.topic === "Resolved topic",
        ),
      "resolved topic in the session listing",
    );
    expect(listAgentSessions(opencode.id)).toHaveLength(1);
    expect(listAgentSessions(opencode.id)[0]).toMatchObject({
      sessionId: "fake-session-1",
      topic: "Resolved topic",
      firstUserMessage: "first request",
    });
  });

  it("backend not installed: surfaces the not-configured hint on first message, no crash", async () => {
    const HINT = "Codex CLI not found. Install it to use this agent.";
    const INSTALL_CMD = "npm i -g @openai/codex";
    // The throw MUST originate from send(), not createSession(). A createSession
    // throw hits spawn's generic catch ("Failed to start", state "error") - a
    // DIFFERENT contract. The onboarding contract is the first-message
    // not-configured presentation: a system hint + terminal-command card, with
    // the agent parked at waiting_for_response. Modeling it at onSend mirrors the
    // real lazy-bootstrap (the backend only fails when first asked to run).
    const fakeBackend = new FakeBackend({
      session: {
        onSend: () => {
          throw new BackendNotConfiguredError(HINT, INSTALL_CMD);
        },
      },
    });
    server = await startTestServer({ fakeBackend });
    const rawSessionId = await claimOwner(server, "Morgan");

    const codex = requireAgentByName(server, CODEX_WELCOME);
    const sock = await connectAsOwner(server, rawSessionId);

    await server.http(`/api/agents/${codex.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
      rawSessionId,
    });

    await waitForLog(
      sock,
      codex.id,
      (e) => e.kind === "system" && e.content.includes(HINT),
    );
    await waitForLog(
      sock,
      codex.id,
      (e) =>
        e.kind === "terminal-command" && e.terminal?.command === INSTALL_CMD,
    );
    await waitForState(server, codex.id, "waiting_for_response");

    // No crash: the office survived the broken backend (all welcome agents
    // still present, server still serving).
    expect(server.agentManager.getAllAgents().length).toBe(4);
  });
});

// OpenCode runs only on Linux and macOS (server/backends/opencode/runtime.ts).
// Elsewhere a fresh office seeds no OpenCode agent, and full_state tells the
// pickers.
describe("onboarding by host platform", () => {
  async function claimOn(platform: NodeJS.Platform) {
    server = await startTestServer({ startServer: { hostPlatform: platform } });
    const session = await claimOwner(server, "Morgan");
    const sock = await server.connectWs(session);
    const fullState = await sock.waitFor("full_state");
    const agents = server.agentManager.getAllAgents();
    const receptionist = agents.find((a) => a.roomId === "lobby");
    expect(receptionist).toBeDefined();
    return { agents, receptionist: receptionist!, fullState };
  }

  // App hosting needs systemd, so macOS reports apps as unavailable.
  for (const [platform, unavailableFeatures] of [
    ["linux", {}],
    ["darwin", { apps: "needs_linux" }],
  ] as const) {
    it(`${platform} seeds the OpenCode Receptionist and Free Welcome Agent, and every engine is available`, async () => {
      const { agents, receptionist, fullState } = await claimOn(platform);
      expect(receptionist.agentType).toBe("opencode");
      expect(receptionist.permissionMode).toBe("bypassPermissions");
      expect(agents.map((a) => a.name)).toContain(OPENCODE_WELCOME);
      expect(fullState.unavailableEngines).toEqual({});
      expect(fullState.unavailableFeatures).toEqual(unavailableFeatures);
    });
  }

  it("an unsupported host seeds a Claude Receptionist with the same permission mode and no Free Welcome Agent", async () => {
    const { agents, receptionist, fullState } = await claimOn("win32");
    expect(receptionist.agentType).toBe("claude");
    expect(receptionist.modelFamily).toBe(MODEL_FAMILIES[0].family);
    expect(receptionist.permissionMode).toBe("bypassPermissions");
    expect(agents.every((a) => a.agentType !== "opencode")).toBe(true);
    expect(agents.map((a) => a.name).sort()).toEqual(
      [CLAUDE_WELCOME, CODEX_WELCOME, receptionist.name].sort(),
    );
    for (const agent of agents.filter((a) => a.roomId !== "lobby")) {
      expect(agent.customInstructions).toContain(CLAUDE_WELCOME);
      expect(agent.customInstructions).toContain(CODEX_WELCOME);
      expect(agent.customInstructions).not.toContain(OPENCODE_WELCOME);
    }
    expect(fullState.unavailableEngines).toEqual({ opencode: "needs_linux" });
    expect(fullState.unavailableFeatures).toEqual({ apps: "needs_linux" });
  });
});
