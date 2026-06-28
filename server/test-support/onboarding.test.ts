// Phase 1.1 — Flagship onboarding / fresh-install characterization.
//
// Freezes the observable contract of the welcome-agent seed across the three
// backend-availability states a brand-new office can be in. This is the first
// REAL characterization test on the 0.3 harness (harness.test.ts stays a thin
// smoke proving the harness itself); the richer projection/ACL and persistence
// nets are 1.2 / 1.3.
//
// How the seed is exercised (NOT via harness.seedOwner): the one-Opus + one-Codex
// welcome seed fires from the onOwnerCreated hook on the HTTP claim path. We go
// through a real POST /auth/claim so the hook runs; seedOwner() calls
// _testSeedOwner directly and bypasses it.
//
// Backend states are scripted on a single injected FakeBackend. The harness
// resolver is `() => fakeBackend` and ignores agentType, so ONE fake drives both
// welcome agents (incl. detectAuthError + getLoginInstructions). Spawn creates a
// session synchronously but never auto-sends; every normal/error behavior here
// surfaces on the FIRST user message, so each state is driven by a WS
// the message endpoint and observed on the wire (log_entry) plus in-memory state.
//
// The first user message also kicks off fire-and-forget topic generation
// (oneShotPrompt); the fake resolves it synchronously so its tail settles before
// teardown, and these tests make no assertions about it (per review: no brittle
// call-count coupling to topic-gen interleaving).
//
// Zero LLM calls: bun test. The opt-in T3 live logged-in happy path is deferred
// to Phase 1.4 (where the live/adapter infra lands); see live-gate.ts.

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
import type { AgentInfo, LogEntry } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Real tokenless owner claim over HTTP. Returns the minted session cookie. The
// claim AWAITS onOwnerCreated, so by the time this resolves both welcome agents
// are already spawned into officeState.
async function claimOwner(srv: TestServer, name: string): Promise<string> {
  const res = await srv.http("/auth/claim", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `name=${encodeURIComponent(name)}`,
    redirect: "manual",
  });
  if (res.status !== 302) throw new Error(`claim failed: HTTP ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(
    /isomux_session=([^;]+)/,
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
// — topic generation interleaves its own events on the first message).
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

// Resolve a seeded welcome agent by name, failing clearly (vs a bare non-null
// assertion's generic throw) if the seed ever regresses.
function requireAgentByName(srv: TestServer, name: string): AgentInfo {
  const agent = srv.agentManager.getAllAgents().find((a) => a.name === name);
  expect(agent).toBeDefined();
  return agent as AgentInfo;
}

describe("onboarding / fresh install (Phase 1.1)", () => {
  it("seeds one Claude (Opus) + one Codex welcome agent on the first-owner claim", async () => {
    // Default harness backend; the seed never sends, so its onSend is irrelevant.
    server = await startTestServer();
    await claimOwner(server, "Boss");

    const agents = server.agentManager.getAllAgents();
    expect(agents.length).toBe(2);

    const claude = agents.find((a) => a.name === CLAUDE_WELCOME);
    const codex = agents.find((a) => a.name === CODEX_WELCOME);
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();

    // Backend + model + permission identity each welcome agent ships with.
    expect(claude!.agentType).toBe("claude");
    expect(claude!.modelFamily).toBe("opus");
    expect(claude!.permissionMode).toBe("auto");
    expect(codex!.agentType).toBe("codex");
    expect(codex!.modelFamily).toBe("gpt-5.5");
    expect(codex!.permissionMode).toBe("on-request");

    // Lazy spawn: the welcome agents are seeded DORMANT — zero subprocesses
    // until someone messages them (a fresh-install office shouldn't burn ~330MB
    // on two agents nobody has talked to yet). The `agents.length === 2` check
    // above already guards the accidental double-seed regression the
    // onOwnerCreated guard prevents.
    expect(server.fakeBackend.createSessionCount).toBe(0);
    expect(claude!.dormant).toBe(true);
    expect(codex!.dormant).toBe(true);

    // Persisted to disk under the temp STATE_ROOT (parse records, not substring).
    const names = persistedAgentRecords().map((a) => a.name);
    expect(names).toContain(CLAUDE_WELCOME);
    expect(names).toContain(CODEX_WELCOME);
  });

  it("backend logged in: a messaged welcome agent completes its first turn", async () => {
    const fakeBackend = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    server = await startTestServer({ fakeBackend });
    const rawSessionId = await claimOwner(server, "Boss");

    const claude = requireAgentByName(server, CLAUDE_WELCOME);
    const sock = await connectAsOwner(server, rawSessionId);

    await server.http(`/api/agents/${claude.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
      rawSessionId,
    });

    // The completed turn streams the assistant text, then lands the agent in
    // waiting_for_response (deriveStateFromEvent: completed -> waiting_for_response;
    // idle is only the pre-turn state).
    await waitForLog(
      sock,
      claude.id,
      (e) => e.kind === "text" && e.content === "ok",
    );
    await waitForState(server, claude.id, "waiting_for_response");
  });

  it("backend installed but not logged in: surfaces sign-in instructions", async () => {
    const LOGIN = "Sign in: run `claude`, then `/login`.";
    const LOGIN_CMD = "claude /login";
    const fakeBackend = new FakeBackend({
      // A failed turn whose error text reads as an auth failure.
      session: {
        onSend: (_t, _a, s) =>
          s.completeTurn({
            status: "failed",
            error: "Error: not logged in. Run /login to authenticate.",
          }),
      },
      isAuthError: (t) => /not logged in|\/login/i.test(t),
      loginInstructions: { text: LOGIN, commands: [LOGIN_CMD] },
    });
    server = await startTestServer({ fakeBackend });
    const rawSessionId = await claimOwner(server, "Boss");

    const claude = requireAgentByName(server, CLAUDE_WELCOME);
    const sock = await connectAsOwner(server, rawSessionId);

    await server.http(`/api/agents/${claude.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
      rawSessionId,
    });

    // Observable shape: an error log, the backend's login text as a system log,
    // and a clickable terminal-command card for the login command.
    await waitForLog(sock, claude.id, (e) => e.kind === "error");
    await waitForLog(
      sock,
      claude.id,
      (e) => e.kind === "system" && e.content.includes(LOGIN),
    );
    await waitForLog(
      sock,
      claude.id,
      (e) => e.kind === "terminal-command" && e.terminal?.command === LOGIN_CMD,
    );
    // Auth failure parks at waiting_for_response ("user needs to sign in"), not
    // "error" ("agent crashed").
    await waitForState(server, claude.id, "waiting_for_response");
  });

  it("backend not installed: surfaces the not-configured hint on first message, no crash", async () => {
    const HINT = "Codex CLI not found. Install it to use this agent.";
    const INSTALL_CMD = "npm i -g @openai/codex";
    // The throw MUST originate from send(), not createSession(). A createSession
    // throw hits spawn's generic catch ("Failed to start", state "error") — a
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
    const rawSessionId = await claimOwner(server, "Boss");

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

    // No crash: the office survived the broken backend (both welcome agents
    // still present, server still serving).
    expect(server.agentManager.getAllAgents().length).toBe(2);
  });
});
