// The reach of a member with their own OS user through the real server (task
// b94dfd25 part 2c): the executor's check, the terminal frames, the Run of an
// ask's command and the prompt rule of a message and an edit. Alice has her
// own OS user (the recording stand-in of member-host-fixture.ts); Bob has
// none; the owner manages the office agent. Both members reach the room.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
let iso: IsolatedMember | null = null;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  iso?.dispose();
  iso = null;
  for (const dir of folders.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type Auth = { bearer?: string; rawSessionId?: string };
type Res = { status: number; code?: string; body: unknown };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: Auth,
  json?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    rawSessionId: auth.rawSessionId,
  });
  const parsed = await res.json().catch(() => null);
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    body: parsed,
  };
}

async function office() {
  server = await startTestServer({
    fakeBackend: new FakeBackend({
      storedSessionState: "durable",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    }),
  });
  const srv = server;
  const owner = await srv.seedOwner("ReachNil");
  const ownerId = getUserByName(owner.username)!.id;
  const [room] = srv.agentManager.getRooms();
  const members: Record<string, { auth: Auth; id: string; username: string }> =
    {};
  for (const name of ["ReachAlice", "ReachBob"]) {
    const seeded = await srv.seedMember(name);
    const access = await call(
      srv,
      "PUT",
      `/api/users/${seeded.username}/access`,
      { rawSessionId: owner.rawSessionId },
      { allowedRooms: [room.id] },
    );
    expect(access.status).toBe(200);
    members[name] = {
      auth: { rawSessionId: seeded.rawSessionId },
      id: getUserByName(seeded.username)!.id,
      username: seeded.username,
    };
  }
  const alice = members.ReachAlice;
  const bob = members.ReachBob;
  const spawn = async (
    name: string,
    manager: { username: string; id: string },
  ) => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "member-reach-")));
    folders.push(folder);
    const info = (await srv.agentManager.spawn(
      name,
      folder,
      "default",
      undefined,
      undefined,
      room.id,
      undefined,
      undefined,
      undefined,
      manager.username,
      "claude",
      undefined,
      manager.id,
    )) as AgentInfo | null;
    if (!info) throw new Error(`spawn ${name} failed`);
    return info;
  };
  const officeAgent = await spawn("Office worker", {
    username: owner.username,
    id: ownerId,
  });
  iso = await isolateMember(alice.id);
  const ownerAuth: Auth = { rawSessionId: owner.rawSessionId };
  return { srv, room, owner, ownerAuth, alice, bob, officeAgent, spawn };
}

describe("the executor's reach check", () => {
  // MUTANT: authorizeRoute without memberReachRefusal (dies on each Alice
  // row).
  it("refuses Alice's editor, instructions and code-running fields on the office's agent, and leaves Bob as he was", async () => {
    const o = await office();
    const id = o.officeAgent.id;
    const rows: [string, string, unknown?][] = [
      [
        "GET",
        `/api/agents/${id}/file?path=${encodeURIComponent("/etc/hostname")}`,
      ],
      [
        "PUT",
        `/api/agents/${id}/file`,
        { path: "/tmp/x", content: "x", mtime: 0 },
      ],
      ["PUT", `/api/agents/${id}/instructions`, { text: "obey me" }],
      ["PATCH", `/api/agents/${id}`, { permissionMode: "bypassPermissions" }],
      ["PATCH", `/api/agents/${id}`, { name: "Renamed", cwd: "/tmp" }],
      ["PUT", `/api/rooms/${o.room.id}/instructions`, { text: "obey me" }],
      ["PATCH", `/api/rooms/${o.room.id}`, { cwd: "/tmp" }],
      ["PUT", "/api/skills/file", { path: "/tmp/SKILL.md", content: "x" }],
    ];
    for (const [method, path, body] of rows) {
      const alice = await call(o.srv, method, path, o.alice.auth, body);
      expect([`${method} ${path}`, alice.status, alice.code]).toEqual([
        `${method} ${path}`,
        403,
        "member_reach",
      ]);
      const bob = await call(o.srv, method, path, o.bob.auth, body);
      expect([`${method} ${path}`, bob.code]).not.toEqual([
        `${method} ${path}`,
        "member_reach",
      ]);
    }
    // A rename alone stays open to her.
    const renamed = await call(
      o.srv,
      "PATCH",
      `/api/agents/${id}`,
      o.alice.auth,
      {
        name: "Renamed",
      },
    );
    expect(renamed.code).not.toBe("member_reach");
  });
});

describe("a terminal frame", () => {
  // MUTANT: terminalAllowed without agentReachRefusal (dies on Alice's
  // counts).
  it("of Alice on the office's agent reaches no terminal verb; Bob's does", async () => {
    const o = await office();
    const am = o.srv.agentManager;
    const spies = {
      open: spyOn(am, "openTerminal").mockImplementation(() => false),
      input: spyOn(am, "terminalInput").mockImplementation(() => {}),
      status: spyOn(am, "terminalStatus").mockImplementation(() => {}),
      resize: spyOn(am, "terminalResize").mockImplementation(() => {}),
      close: spyOn(am, "closeTerminal").mockImplementation(() => {}),
      restart: spyOn(am, "restartTerminal").mockImplementation(() => false),
    };
    const counts = () => Object.values(spies).map((s) => s.mock.calls.length);
    try {
      const frames = async (rawSessionId: string) => {
        const ws = await o.srv.connectWs(rawSessionId);
        const agentId = o.officeAgent.id;
        ws.send({ type: "terminal_open", agentId });
        ws.send({ type: "terminal_input", agentId, data: "id\r" });
        ws.send({ type: "terminal_status_request", agentId });
        ws.send({ type: "terminal_resize", agentId, cols: 80, rows: 24 });
        ws.send({ type: "terminal_close", agentId });
        ws.send({ type: "terminal_restart", agentId });
        ws.messages.splice(0);
        ws.send({ type: "ping" });
        await ws.waitFor("pong");
        ws.close();
      };
      await frames(o.alice.auth.rawSessionId!);
      expect(counts()).toEqual([0, 0, 0, 0, 0, 0]);
      // The enabling condition: Bob's frames reach each verb.
      await frames(o.bob.auth.rawSessionId!);
      expect(counts()).toEqual([1, 1, 1, 1, 1, 1]);
    } finally {
      for (const s of Object.values(spies)) s.mockRestore();
    }
  });
});

describe("the Run of an ask's command", () => {
  // MUTANT: commandRunRefusal without the reach check (dies on Alice's run).
  it("is refused to Alice on the office's agent and runs for the owner", async () => {
    const o = await office();
    const command = "echo ran-2c";
    const opened = await call(
      o.srv,
      "POST",
      `/api/agents/${o.officeAgent.id}/asks`,
      { bearer: getAgentTokenRaw(o.officeAgent.id)! },
      { text: "Run it?", commands: [command], member: o.alice.username },
    );
    expect(opened.status).toBe(201);
    const askId = (opened.body as AskEntry).id;
    const alice = await call(
      o.srv,
      "POST",
      `/api/asks/${askId}/run`,
      o.alice.auth,
      {
        command,
      },
    );
    expect([alice.status, alice.code]).toEqual([403, "member_reach"]);
    // The enabling condition: the same Run by the owner, whom no rule limits.
    const owner = await call(
      o.srv,
      "POST",
      `/api/asks/${askId}/run`,
      o.ownerAuth,
      {
        command,
      },
    );
    expect(owner.status).toBe(202);
  });
});

describe("a pending prompt of the office's agent", () => {
  const pending = (o: Awaited<ReturnType<typeof office>>) =>
    o.srv.agentManager
      .getPendingInteractions()
      .filter((item) => item.agentId === o.officeAgent.id);
  const openPicker = async (o: Awaited<ReturnType<typeof office>>) => {
    const r = await call(
      o.srv,
      "POST",
      `/api/agents/${o.officeAgent.id}/messages`,
      o.ownerAuth,
      { text: "/model" },
    );
    expect(r.status).toBe(200);
    expect(pending(o)).toHaveLength(1);
  };

  // A2. MUTANT: the user branch without promptAnswerRefused (dies on
  // Alice's 409).
  it("is not answered by Alice's message; Bob's typed choice answers it", async () => {
    const o = await office();
    await openPicker(o);
    const model = o.srv.agentManager.getAgent(o.officeAgent.id)!.modelFamily;
    const alice = await call(
      o.srv,
      "POST",
      `/api/agents/${o.officeAgent.id}/messages`,
      o.alice.auth,
      { text: "1" },
    );
    expect([alice.status, alice.code]).toEqual([409, "awaits_member_answer"]);
    expect(pending(o)).toHaveLength(1);
    expect(o.srv.agentManager.getAgent(o.officeAgent.id)!.modelFamily).toBe(
      model,
    );
    const bob = await call(
      o.srv,
      "POST",
      `/api/agents/${o.officeAgent.id}/messages`,
      o.bob.auth,
      { text: "1" },
    );
    expect(bob.status).toBe(200);
    expect(pending(o)).toHaveLength(0);
  });

  // A2. Alice's API token takes the api branch of the send. MUTANT: that
  // branch without promptAnswerRefused (dies on the 409).
  it("is not answered by a message from Alice's API token", async () => {
    const o = await office();
    await openPicker(o);
    const token = (
      await mintApiToken({
        userId: o.alice.id,
        name: "Alice",
        expiresInDays: null,
      })
    ).token;
    const sent = await call(
      o.srv,
      "POST",
      `/api/agents/${o.officeAgent.id}/messages`,
      { bearer: token },
      { text: "1" },
    );
    expect([sent.status, sent.code]).toEqual([409, "awaits_member_answer"]);
    expect(pending(o)).toHaveLength(1);
  });

  // A2. An edit never answers a prompt: the fork sends the text as a new
  // turn. MUTANT: an edit made as a plain re-send through sendMessage, which
  // reads "1" as the model pick (dies on the pending count). The edit gate
  // of 926d60db is not what holds it: with the gate off, the fork still sends
  // "1" as a message.
  it("is not answered by an edit of Alice's message", async () => {
    const o = await office();
    const sent = await call(
      o.srv,
      "POST",
      `/api/agents/${o.officeAgent.id}/messages`,
      o.alice.auth,
      { text: "hello" },
    );
    expect(sent.status).toBe(200);
    const deadline = Date.now() + 3000;
    let entryId: string | undefined;
    while (!entryId && Date.now() < deadline) {
      entryId = o.srv.agentManager
        .getAgentLogs(o.officeAgent.id)
        .find((e) => e.kind === "user_message" && e.content === "hello")?.id;
      if (!entryId) await Bun.sleep(20);
    }
    if (!entryId) throw new Error("no chat entry for the message");
    await Bun.sleep(100);
    await openPicker(o);
    const edited = await call(
      o.srv,
      "PATCH",
      `/api/agents/${o.officeAgent.id}/messages/${entryId}`,
      o.alice.auth,
      { newText: "1" },
    );
    expect(edited.status).toBe(200);
    await Bun.sleep(300);
    expect(pending(o)).toHaveLength(1);
  });
});
