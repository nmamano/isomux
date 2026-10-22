// GET /api/agents/:id/terminal (opId agents.terminal, task 11d010ab): an agent
// reads its own terminal and the terminal of any agent in a room its member
// can access. The cleaning and redaction rules are pinned in
// server/terminal-text.test.ts; this file pins the route: who reaches it, the
// response shape, the open/truncated flags and the lines parameter.
//
// Seam: startTestServer(). FakeBackend has no PTY, so a terminal is seeded
// through the manager's _testSeedTerminalBuffer.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import type { TerminalReadRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

// server/terminal.ts MAX_PTY_BUFFER (100K characters, the task's scope).
const MAX_PTY_BUFFER = 100_000;

async function spawnIn(
  srv: TestServer,
  name: string,
  roomId: string,
  manager?: { username: string },
) {
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    manager?.username,
    "claude",
    undefined,
    manager ? getUserByName(manager.username)?.id : undefined,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

async function read(
  srv: TestServer,
  agentId: string,
  auth: { bearer?: string; rawSessionId?: string },
  query = "",
): Promise<{ status: number; body: unknown }> {
  const res = await srv.http(`/api/agents/${agentId}/terminal${query}`, {
    headers: auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {},
    rawSessionId: auth.rawSessionId,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const errCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;

async function ownerOffice() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const roomId = srv.agentManager.getRooms()[0].id;
  const ownerId = getUserByName(owner.username)!.id;
  return { srv, owner, roomId, ownerId };
}

describe("agents.terminal reach", () => {
  it("an agent reads its own terminal and one in its member's rooms, and is refused one outside them, like its member", async () => {
    const srv = await startTestServer();
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("R2");
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mia");
    const put = await srv.http(
      `/api/users/${encodeURIComponent(member.username)}/access`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        rawSessionId: owner.rawSessionId,
        body: JSON.stringify({ allowedRooms: [r1] }),
      },
    );
    expect(put.ok).toBe(true);

    const self = await spawnIn(srv, "Self", r1, member);
    const visible = await spawnIn(srv, "Vis", r1);
    const hidden = await spawnIn(srv, "Hid", r2);
    srv.agentManager._testSeedTerminalBuffer(self.id, "mine\r\n");
    srv.agentManager._testSeedTerminalBuffer(visible.id, "visible\r\n");
    srv.agentManager._testSeedTerminalBuffer(hidden.id, "HIDDEN-OUTPUT\r\n");
    const token = mintAgentToken(self.id, getUserByName(member.username)!.id);

    for (const [agent, output] of [
      [self, "mine\n"],
      [visible, "visible\n"],
    ] as const) {
      const ok = await read(srv, agent.id, { bearer: token });
      expect(ok.status).toBe(200);
      expect((ok.body as TerminalReadRes).output).toBe(output);
    }

    const denied = await read(srv, hidden.id, { bearer: token });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain("HIDDEN-OUTPUT");

    // The member's own session has the same reach as its agent.
    const memberDenied = await read(srv, hidden.id, {
      rawSessionId: member.rawSessionId,
    });
    expect(memberDenied.status).toBe(403);
    const ownerOk = await read(srv, hidden.id, {
      rawSessionId: owner.rawSessionId,
    });
    expect(ownerOk.status).toBe(200);
  });
});

describe("agents.terminal response", () => {
  it("reports open:false for no terminal; returns the cleaned, redacted buffer; flags a full buffer truncated and drops its partial first line", async () => {
    const { srv, owner, roomId } = await ownerOffice();
    const asOwner = { rawSessionId: owner.rawSessionId };
    const none = await spawnIn(srv, "None", roomId);
    const r0 = await read(srv, none.id, asOwner);
    expect(r0.status).toBe(200);
    expect(r0.body).toEqual({ open: false, output: "", truncated: false });

    const a = await spawnIn(srv, "A", roomId);
    const body = "Q7wErTy9UiOp4AsDfGh2JkLzXcVbNm";
    srv.agentManager._testSeedTerminalBuffer(
      a.id,
      `\x1b[32m$\x1b[0m echo hi\r\nhi\r\n50%\r100%\r\nexport API_KEY=${body}\r\n$ `,
    );
    const r = await read(srv, a.id, asOwner);
    expect(r.status).toBe(200);
    const res = r.body as TerminalReadRes;
    expect(res.open).toBe(true);
    expect(res.truncated).toBe(false);
    const lines = res.output.split("\n");
    expect(lines.slice(0, 3)).toEqual(["$ echo hi", "hi", "100%"]);
    expect(lines.at(-1)).toBe("$ ");
    expect(res.output).not.toContain(body);
    expect(lines[3]).toStartWith("export API_KEY=" + body.slice(0, 8));

    const full = await spawnIn(srv, "Full", roomId);
    const under = await spawnIn(srv, "Under", roomId);
    const make = (length: number) => {
      const head = "partial-first-line\r\n";
      const tail = "\r\nlast\r\n$ ";
      return head + "x".repeat(length - head.length - tail.length) + tail;
    };
    const atMax = make(MAX_PTY_BUFFER);
    const belowMax = make(MAX_PTY_BUFFER - 1);
    expect(atMax.length).toBe(MAX_PTY_BUFFER);
    expect(belowMax.length).toBe(MAX_PTY_BUFFER - 1);
    srv.agentManager._testSeedTerminalBuffer(full.id, atMax);
    srv.agentManager._testSeedTerminalBuffer(under.id, belowMax);

    const f = (await read(srv, full.id, asOwner)).body as TerminalReadRes;
    expect(f.truncated).toBe(true);
    expect(f.output).not.toContain("partial-first-line");
    expect(f.output.endsWith("\nlast\n$ ")).toBe(true);
    // One character under the limit nothing was dropped: the first line stays.
    const u = (await read(srv, under.id, asOwner)).body as TerminalReadRes;
    expect(u.truncated).toBe(false);
    expect(u.output.startsWith("partial-first-line\n")).toBe(true);
  });
});

describe("agents.terminal lines", () => {
  it("returns the last N lines, and refuses a lines value that is not an integer from 1 to 10000", async () => {
    const { srv, owner, roomId } = await ownerOffice();
    const asOwner = { rawSessionId: owner.rawSessionId };
    const a = await spawnIn(srv, "A", roomId);
    srv.agentManager._testSeedTerminalBuffer(a.id, "one\r\ntwo\r\nthree\r\n$ ");
    const r = await read(srv, a.id, asOwner, "?lines=2");
    expect(r.status).toBe(200);
    expect((r.body as TerminalReadRes).output.split("\n")).toEqual([
      "three",
      "$ ",
    ]);
    const max = await read(srv, a.id, asOwner, "?lines=10000");
    expect(max.status).toBe(200);
    expect((max.body as TerminalReadRes).output).toBe("one\ntwo\nthree\n$ ");

    for (const query of [
      "?lines=0",
      "?lines=-1",
      "?lines=1.5",
      "?lines=abc",
      "?lines=",
      "?lines=10001",
      "?lines=1&lines=2",
    ]) {
      const bad = await read(srv, a.id, asOwner, query);
      expect({ query, status: bad.status, code: errCode(bad.body) }).toEqual({
        query,
        status: 400,
        code: "invalid_lines",
      });
    }
  });
});
