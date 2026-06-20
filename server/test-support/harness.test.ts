// Phase 0.3 exit-criterion proof for the in-process harness: a T1 test boots the
// real server against a temp ISOMUX_HOME, connects multiple authenticated
// sockets, drives a FakeBackend (zero LLM), and asserts on persisted files. The
// richer onboarding / projection flows are Phase 1; this is the smoke that
// proves the harness itself works.
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { expectRejection } from "./expect-rejection.ts";
import { STATE_ROOT } from "../config.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function waitForFile(path: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`file never written: ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("in-process harness (Phase 0.3 exit criterion)", () => {
  it("runs against a non-production STATE_ROOT (preload presets ISOMUX_HOME)", () => {
    // The harness refuses to boot otherwise (assertSafeToDelete); assert the
    // safety-critical property directly too.
    expect(STATE_ROOT).not.toBe(join(homedir(), ".isomux"));
  });

  it("boots the real server on an ephemeral port against temp state", async () => {
    server = await startTestServer();
    expect(server.port).toBeGreaterThan(0);
    expect(server.stateRoot).toBe(STATE_ROOT);
    expect(existsSync(STATE_ROOT)).toBe(true);
  });

  it("claims the owner through POST /auth/claim on the ephemeral port", async () => {
    server = await startTestServer();
    // Real tokenless claim over HTTP. http() sends Origin =
    // buildPublicOrigin().origin (the actual bound port); the claim Origin
    // check must accept it. This 403s ("bad origin") if that check still
    // derived its allowed origin from a hardcoded 4000 instead of the
    // bound-port seam.
    const res = await server.http("/auth/claim", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=ClaimedOwner",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/isomux_session=([^;]+)/);
    expect(match).not.toBeNull();
    // The minted session is real and usable over the authenticated WS.
    const sock = await server.connectWs(match![1]);
    const ctx = await sock.waitFor("session_context");
    expect((ctx.context as { role: string }).role).toBe("owner");
  });

  it("connects multiple authenticated sockets (owner tabs + member)", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Member");

    const tabA = await server.connectWs(owner.rawSessionId);
    const tabB = await server.connectWs(owner.rawSessionId);
    const memberSock = await server.connectWs(member.rawSessionId);

    const ctxA = await tabA.waitFor("session_context");
    const ctxB = await tabB.waitFor("session_context");
    const ctxM = await memberSock.waitFor("session_context");

    const ctx = (m: Record<string, unknown>) =>
      m.context as { role: string; connectionId: string; username: string };
    expect(ctx(ctxA).role).toBe("owner");
    expect(ctx(ctxB).role).toBe("owner");
    expect(ctx(ctxM).role).toBe("member");
    // Same owner cookie, distinct per-WS connection ids (one ghost per tab).
    expect(ctx(ctxA).connectionId).not.toBe(ctx(ctxB).connectionId);
    // Each socket also receives the projected office snapshot on connect.
    expect(await tabA.waitFor("full_state")).toBeTruthy();
  });

  it("rejects an unauthenticated socket", async () => {
    server = await startTestServer();
    await expectRejection(
      server.connectWs("not-a-real-session"),
      /WebSocket connection failed/,
    );
  });

  it("drives a FakeBackend on spawn and persists agents.json (zero LLM)", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");

    const roomId = server.agentManager.getRooms()[0].id;
    const agent = await server.agentManager.spawn(
      "SmokeAgent",
      server.stateRoot,
      "default",
      undefined,
      undefined,
      roomId,
    );
    expect(agent).not.toBeNull();

    // The injected FakeBackend was driven (a session was created), proving no
    // real provider/LLM call happened.
    expect(server.fakeBackend.createSessionCount).toBeGreaterThan(0);
    expect(server.fakeBackend.sessionForAgent(agent!.id)).toBeDefined();

    // Persisted-file assertion: agents.json under the temp STATE_ROOT.
    const agentsPath = join(STATE_ROOT, "agents.json");
    await waitForFile(agentsPath);
    expect(readFileSync(agentsPath, "utf8")).toContain("SmokeAgent");
  });

  it("refuses a second concurrent harness (single-instance-per-process)", async () => {
    server = await startTestServer();
    await expectRejection(startTestServer(), /already active/);
  });
});
