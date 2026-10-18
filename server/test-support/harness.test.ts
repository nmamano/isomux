// Phase 0.3 exit-criterion proof for the in-process harness: a T1 test boots the
// real server against a temp ISOMUX_HOME, connects multiple authenticated
// sockets, drives a FakeBackend (zero LLM), and asserts on persisted files. The
// richer onboarding / projection flows are Phase 1; this is the smoke that
// proves the harness itself works.
import { sessionCookieName } from "../auth.ts";
import { describe, it, expect, afterEach } from "bun:test";
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { expectRejection } from "./expect-rejection.ts";
import { STATE_ROOT } from "../config.ts";
import { OFFICE_DATABASE, officeAuditStore } from "../audit-store.ts";

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
    // Real claim over HTTP with the setup key the boot wrote to the state dir.
    const res = await server.http("/auth/claim", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `name=ClaimedOwner&key=${encodeURIComponent(server.setupKey())}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = setCookie.match(new RegExp(`${sessionCookieName()}=([^;]+)`));
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

  it("persists agents.json on spawn and drives a FakeBackend on first message (zero LLM)", async () => {
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

    // Lazy spawn: no subprocess until the first message.
    expect(server.fakeBackend.createSessionCount).toBe(0);
    expect(server.agentManager.getAgent(agent!.id)?.dormant).toBe(true);

    // First message wakes it: the injected FakeBackend is driven (a session is
    // created), proving no real provider/LLM call happened.
    server.agentManager.enqueueMessage(agent!.id, {
      sender: { kind: "user", username: "Boss" },
      text: "hi",
    });
    const deadline = Date.now() + 2000;
    while (
      server.fakeBackend.createSessionCount === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
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

describe("the office database across fresh boots", () => {
  const officeFile = () => join(STATE_ROOT, OFFICE_DATABASE);
  const auditWrite = {
    actor: { kind: "member" as const, id: "member-1", name: "Member" },
    operation: "tasks.create",
    targets: ["task-1"],
    fields: [],
  };

  it("starts empty in the same file, so a boot creates no new database", async () => {
    server = await startTestServer();
    const store = officeAuditStore();
    store.append(auditWrite);
    store.db
      .query("INSERT INTO tasks(id, record) VALUES ('task-1', '{}')")
      .run();
    const fd = openSync(officeFile(), "r");
    await server.stop();

    try {
      server = await startTestServer();
      // Still linked: the boot reused the file instead of replacing it.
      expect(fstatSync(fd).nlink).toBe(1);
    } finally {
      closeSync(fd);
    }
    const { db, list, append } = officeAuditStore();
    expect(db.query("SELECT * FROM tasks").all()).toHaveLength(0);
    expect(list().items).toHaveLength(0);
    expect(db.query("SELECT * FROM audit_targets").all()).toHaveLength(0);
    // A new file numbers its first entry 1; an emptied one must too.
    expect(append(auditWrite)).toBe(1);
  });

  it("is a new file when a test changed its schema", async () => {
    server = await startTestServer();
    officeAuditStore().db.exec(
      "CREATE TRIGGER audit_fail BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    const fd = openSync(officeFile(), "r");
    await server.stop();

    try {
      server = await startTestServer();
      expect(fstatSync(fd).nlink).toBe(0);
    } finally {
      closeSync(fd);
    }
    expect(
      officeAuditStore()
        .db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all(),
    ).toHaveLength(0);
    expect(officeAuditStore().append(auditWrite)).toBe(1);
  });
});
