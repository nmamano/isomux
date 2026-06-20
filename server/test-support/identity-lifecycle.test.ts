// Phase 2.1 — Identity & capabilities: agent token lifecycle + redaction.
// (The cron RUN-token lifecycle lives in cronjob-manager.di.test.ts.)
//
// TDD red-green for NEW code. Drives the REAL AgentManager through the
// in-process harness + FakeBackend (zero LLM): spawn mints a bearer token and
// injects it into the agent's session env; kill revokes it; revive rotates it;
// and the raw token never appears on any externally-visible surface (WS
// messages, log entries, the backend-visible system prompt). ADDITIVE: nothing
// is rejected here — issuance, env-injection, and redaction only.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw, resolveToken } from "../identity/tokens.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function spawnAgent(srv: TestServer, name: string) {
  const roomId = srv.agentManager.getRooms()[0]?.id;
  if (!roomId) throw new Error("harness office has no room to spawn into");
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot, // a real, existing dir (passes validateCwd)
    "default",
    undefined,
    undefined,
    roomId,
  );
  if (!info) throw new Error("spawn returned null");
  return { info, roomId };
}

describe("identity: agent token lifecycle via the manager (Phase 2.1)", () => {
  it("spawn mints a token, resolves to an AGENT identity, and injects ISOMUX_AGENT_TOKEN into the session env", async () => {
    const srv = await startTestServer();
    server = srv;
    const { info } = await spawnAgent(srv, "TokAgent");

    const raw = getAgentTokenRaw(info.id) as string;
    expect(typeof raw).toBe("string");

    const id = resolveToken(raw)!;
    expect(id.scope).toBe("agent");
    expect(id.agentId).toBe(info.id);
    expect(id.userId).toBe(info.userId ?? null);

    // The agent's session subprocess env carries the same raw token.
    const sess = srv.fakeBackend.sessionForAgent(info.id);
    expect(sess?.opts.env?.ISOMUX_AGENT_TOKEN).toBe(raw);
  });

  it("kill revokes the token", async () => {
    const srv = await startTestServer();
    server = srv;
    const { info } = await spawnAgent(srv, "KillAgent");
    const raw = getAgentTokenRaw(info.id) as string;
    expect(resolveToken(raw)).not.toBeNull();

    await srv.agentManager.kill(info.id);
    expect(getAgentTokenRaw(info.id)).toBeNull();
    expect(resolveToken(raw)).toBeNull();
  });

  it("revive rotates the token (old raw dies, new raw resolves)", async () => {
    // autoSystemInit:false -> the spawned agent never gets a sessionId, so kill
    // stamps no lastSessionId and revive takes the fresh path (no Claude
    // resume-file preflight, hence no "[revive] Resume ... falling back"
    // warning in the test log). Token assertions are unaffected: kill still
    // revokes and restoreOrReviveAgent still mints a fresh raw before
    // createSession.
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { autoSystemInit: false } }),
    });
    server = srv;
    const { info, roomId } = await spawnAgent(srv, "ReviveAgent");
    const raw1 = getAgentTokenRaw(info.id) as string;

    await srv.agentManager.kill(info.id);
    expect(resolveToken(raw1)).toBeNull();

    const res = await srv.agentManager.revive(info.id, roomId, info.desk);
    expect(res.ok).toBe(true);

    const raw2 = getAgentTokenRaw(info.id);
    expect(typeof raw2).toBe("string");
    expect(raw2).not.toBe(raw1);
    expect(resolveToken(raw1)).toBeNull(); // old token stays dead
    expect(resolveToken(raw2 as string)?.agentId).toBe(info.id);
  });
});

describe("identity: agent token redaction (Phase 2.1)", () => {
  it("the raw token never appears in WS messages, log entries, or the system prompt", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ws = await srv.connectWs(owner.rawSessionId);

    const { info } = await spawnAgent(srv, "RedactAgent");
    const raw = getAgentTokenRaw(info.id) as string;
    expect(raw.length).toBeGreaterThan(20); // positive control: a real secret exists

    // Let the spawn's events + the first stream flush to the socket.
    await ws.waitFor("log_entry").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    // Sanity: the agent really did surface on this socket (otherwise "absent"
    // would be vacuously true).
    expect(
      ws.messages.some((m) => (m as { type?: string }).type === "agent_added"),
    ).toBe(true);

    // The token must not ride on ANY WS message (covers log_entry, agent_added,
    // slash_commands, full_state, …)...
    expect(JSON.stringify(ws.messages)).not.toContain(raw);
    // ...nor in the backend-visible system prompt.
    const sess = srv.fakeBackend.sessionForAgent(info.id);
    expect(sess?.opts.systemPrompt ?? "").not.toContain(raw);
  });
});
