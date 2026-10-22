// Harness properties that would otherwise fail silently: distinct connection
// ids per tab, a single live harness per process, and an office database that
// starts clean in each boot.
import { describe, it, expect, afterEach } from "bun:test";
import { closeSync, fstatSync, openSync } from "fs";
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

describe("in-process harness (Phase 0.3 exit criterion)", () => {
  it("connects multiple authenticated sockets (owner tabs + member)", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
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
