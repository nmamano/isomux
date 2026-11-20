// The reach of a member with their own OS user through the real server (task
// b94dfd25 part 2c): the executor's check, the terminal frames, the Run of an
// ask's command and the prompt rule of a message and an edit. Alice has her
// own OS user (the recording stand-in of member-host-fixture.ts); Bob has
// none; the owner manages the office agent. Both members reach the room.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import {
  forgetMemberOsUser,
  memberOsUsersPath,
  memberOsUserState,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "../member-os-users.ts";
import { getUserByName } from "../users.ts";
import { connectMemberHost } from "../member-hosts.ts";
import { mintApiToken } from "../api-tokens.ts";
import {
  agentHostMoving,
  moveAgentHost,
  setAgentHostMoveDeps,
  type AgentHostChange,
} from "../agent-host-move.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
let iso: IsolatedMember | null = null;
let moveDepsSet = false;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  iso?.dispose();
  iso = null;
  for (const dir of folders.splice(0))
    rmSync(dir, { recursive: true, force: true });
  // Last: a 3d test that replaced the host move's file steps.
  const reset = moveDepsSet;
  moveDepsSet = false;
  if (reset) setAgentHostMoveDeps(null);
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

// Part 2d-iii-b: the skills page side is chosen by the caller. Alice's page
// comes from her runner (the recording stand-in runs no entry, so her
// catalog is a 502), and every other caller's catalog leaves out the folders
// of her agents (B4).
describe("the skills page", () => {
  // MUTANT: skillContextsFor without the isolated-manager filter (dies on
  // the owner's and Bob's names); memberSkillsFor returning null (dies on
  // Alice's status, and her save reaches the office's file).
  it("of Alice goes to her runner; Bob's and the owner's list no skill of her agents' folders", async () => {
    const o = await office();
    const withSkill = async (
      agent: string,
      manager: { username: string; id: string },
      skill: string,
    ) => {
      const info = await o.spawn(agent, manager);
      const dir = join(info.cwd, ".claude", "skills", skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${skill}\ndescription: ${skill}\n---\nBody of ${skill}.\n`,
      );
      return join(dir, "SKILL.md");
    };
    await withSkill("Alice's agent", o.alice, "reach-alice-proj");
    const bobFile = await withSkill("Bob's agent", o.bob, "reach-bob-proj");
    const names = async (auth: Auth) => {
      const r = await call(o.srv, "GET", "/api/skills", auth);
      expect(r.status).toBe(200);
      const body = r.body as {
        engines: { skills: { name: string }[] }[];
      };
      return new Set(body.engines.flatMap((e) => e.skills.map((s) => s.name)));
    };
    for (const auth of [o.bob.auth, o.ownerAuth]) {
      const listed = await names(auth);
      // The enabling condition: a project skill of an agent in the room is
      // listed.
      expect([
        listed.has("reach-bob-proj"),
        listed.has("reach-alice-proj"),
      ]).toEqual([true, false]);
    }
    const alice = await call(o.srv, "GET", "/api/skills", o.alice.auth);
    expect([alice.status, alice.code]).toEqual([502, "runner_error"]);
    const before = readFileSync(bobFile, "utf8");
    const save = await call(o.srv, "PUT", "/api/skills/file", o.alice.auth, {
      path: bobFile,
      content:
        "---\nname: reach-bob-proj\ndescription: x\n---\nAlice was here.\n",
      expectedRev: 0,
    });
    expect(save.status).not.toBe(200);
    expect(readFileSync(bobFile, "utf8")).toBe(before);
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

// Part 3d, task abdb452b: a manager change between hosts (office <-> member,
// member <-> member) moves the agent (server/agent-host-move.ts); a change
// it cannot make answers a code and changes nothing. A change on one host
// moves the agent as before.
describe("a manager change between hosts", () => {
  const PACK = {
    areas: { agents: "write", tasks: "read" },
    agentCeiling: "office",
  };
  const setManager = (
    o: Awaited<ReturnType<typeof office>>,
    agentId: string,
    userId: string,
  ) =>
    call(o.srv, "PUT", `/api/agents/${agentId}/manager`, o.ownerAuth, {
      userId,
    });
  const stateOf = (o: Awaited<ReturnType<typeof office>>, agentId: string) => {
    const a = o.srv.agentManager.getAgent(agentId)!;
    return {
      userId: a.userId,
      manager: a.manager,
      access: a.access,
      cwd: a.cwd,
      token: getAgentTokenRaw(agentId),
    };
  };
  const refused = async (
    o: Awaited<ReturnType<typeof office>>,
    agentId: string,
    userId: string,
  ) => {
    const before = stateOf(o, agentId);
    const r = await setManager(o, agentId, userId);
    expect([r.status, r.code]).toEqual([409, "member_os_user"]);
    expect(stateOf(o, agentId)).toEqual(before);
  };
  // A plan with one file, so the move reaches files-in whatever the
  // agent's sessions are.
  const somePlan = (agentId: string, toUserId: string) => ({
    userId: toUserId,
    trees: [],
    codex: [],
    claude: [
      {
        agentId,
        sessionId: "5e551011-aaaa-4bbb-8ccc-0123456789ab",
        cwd: "/tmp",
        root: "/tmp",
        personal: false,
      },
    ],
  });

  // MUTANT: the clamp applied before the files (dies on access); no undo
  // of the fields on a failed files-in (dies on userId and token).
  it("changes no field, token or clamp when the files cannot move, answers host_move_failed, and still moves office->Bob", async () => {
    const o = await office();
    const pack = await call(
      o.srv,
      "PUT",
      `/api/users/${o.alice.username}/access`,
      o.ownerAuth,
      { allowedRooms: [o.room.id], pack: PACK },
    );
    expect(pack.status).toBe(200);
    // The enabling condition: the clamp would apply to Alice.
    expect(o.srv.agentManager.getAgent(o.officeAgent.id)!.access).not.toBe(
      "office",
    );
    let staged = 0;
    moveDepsSet = true;
    setAgentHostMoveDeps({
      planIn: (agent, _from, to) => somePlan(agent.id, to),
      stageIn: async () => {
        staged++;
        throw new Error("the runner refused files-in");
      },
    });
    const before = stateOf(o, o.officeAgent.id);
    const r = await setManager(o, o.officeAgent.id, o.alice.id);
    expect([r.status, r.code]).toEqual([500, "host_move_failed"]);
    expect(staged).toBe(1);
    expect(stateOf(o, o.officeAgent.id)).toEqual(before);
    const moved = await setManager(o, o.officeAgent.id, o.bob.id);
    expect(moved.status).toBe(200);
    expect(o.srv.agentManager.getAgent(o.officeAgent.id)!.userId).toBe(
      o.bob.id,
    );
  });

  // MUTANT: agentHostIdentity by "isolated" state only (dies on the
  // not-ready and malformed entries and on the broken file); a not-ready
  // member's host taken as connected (dies on the not-ready row).
  it("refuses a not-ready, a malformed and an unreadable record with member_os_user", async () => {
    const o = await office();
    // Bob gets an entry but no runner: not ready.
    recordMemberOsUser(o.bob.id, { name: "isomux-test-bob", uid: 4545 });
    try {
      await refused(o, o.officeAgent.id, o.bob.id);
    } finally {
      forgetMemberOsUser(o.bob.id);
    }
    const saved = readFileSync(memberOsUsersPath(), "utf8");
    try {
      const entries = JSON.parse(saved) as Record<string, unknown>;
      writeFileSync(
        memberOsUsersPath(),
        JSON.stringify({
          ...entries,
          [o.bob.id]: { name: "Bad Name", uid: -1 },
        }),
      );
      reloadMemberOsUsers();
      await refused(o, o.officeAgent.id, o.bob.id);
      // An unreadable file: every member counts as their own host, and no
      // host is ready. The route refuses the owner caller first (2c counts
      // them as isolated), so the move itself is called here.
      writeFileSync(memberOsUsersPath(), "{");
      reloadMemberOsUsers();
      const before = stateOf(o, o.officeAgent.id);
      const r = await moveAgentHost(o.officeAgent.id, o.bob.id, "test");
      expect(r.ok ? "moved" : [r.status, r.code]).toEqual([
        409,
        "member_os_user",
      ]);
      expect(stateOf(o, o.officeAgent.id)).toEqual(before);
    } finally {
      writeFileSync(memberOsUsersPath(), saved);
      reloadMemberOsUsers();
    }
    // Repaired: the same change moves.
    expect((await setManager(o, o.officeAgent.id, o.bob.id)).status).toBe(200);
  });

  // MUTANT: no agentHostMoving check in the cwd, engine, access, kill or
  // manager handler (dies on that row).
  it("refuses a folder, engine or access change, a kill and a second manager change while the agent moves", async () => {
    const o = await office();
    const id = o.officeAgent.id;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    moveDepsSet = true;
    setAgentHostMoveDeps({
      planIn: (agent, _from, to) => somePlan(agent.id, to),
      stageIn: async () => {
        await gate;
        throw new Error("the runner refused files-in");
      },
    });
    const moving = setManager(o, id, o.alice.id);
    for (let i = 0; i < 300 && !agentHostMoving(id); i++) await Bun.sleep(5);
    expect(agentHostMoving(id)).toBe(true);
    const other = realpathSync(mkdtempSync(join(tmpdir(), "member-reach-")));
    folders.push(other);
    const rows: [string, string, unknown?][] = [
      ["PATCH", `/api/agents/${id}`, { cwd: other }],
      ["PATCH", `/api/agents/${id}`, { agentType: "codex" }],
      ["PUT", `/api/agents/${id}/access`, { access: "office" }],
      ["DELETE", `/api/agents/${id}`],
      ["PUT", `/api/agents/${id}/manager`, { userId: o.bob.id }],
    ];
    try {
      for (const [method, path, body] of rows) {
        const r = await call(o.srv, method, path, o.ownerAuth, body);
        expect([method, path, body, r.status, r.code]).toEqual([
          method,
          path,
          body,
          409,
          "move_in_progress",
        ]);
      }
    } finally {
      open();
    }
    const done = await moving;
    expect([done.status, done.code]).toEqual([500, "host_move_failed"]);
    expect(agentHostMoving(id)).toBe(false);
    expect(o.srv.agentManager.getAgent(id)!.userId).not.toBe(o.alice.id);
    // The mark is gone: the same folder change goes through.
    const after = await call(o.srv, "PATCH", `/api/agents/${id}`, o.ownerAuth, {
      cwd: other,
    });
    expect(after.status).toBe(200);
  });

  // MUTANT: holdMember without the terminal (dies on the first open; red
  // on main 450717bdf, where the enable left it running); holdAgentForMove
  // without it (dies on the second): the next member to open the panel
  // would join the old host's shell.
  it("ends the agent's terminal when it holds the agent, for an agent move and for a member's move", async () => {
    const o = await office();
    const am = o.srv.agentManager;
    const id = o.officeAgent.id;
    const ownerId = getUserByName(o.owner.username)!.id;
    am._testSeedTerminalBuffer(id, "office shell");
    expect(am.readTerminal(id).open).toBe(true);
    await am.holdMember(ownerId);
    expect(am.readTerminal(id).open).toBe(false);
    am.releaseMember(ownerId);
    am._testSeedTerminalBuffer(id, "office shell");
    expect(am.readTerminal(id).open).toBe(true);
    await am.holdAgentForMove(id);
    expect(am.readTerminal(id).open).toBe(false);
    am.releaseAgentMove(id);
  });

  // MUTANT: the move hold released by newConversation's drain (dies: the
  // held message runs before the release).
  it("keeps a held agent's queue through a manager change until the move releases it", async () => {
    const o = await office();
    const am = o.srv.agentManager;
    const id = o.officeAgent.id;
    const sentHeld = () =>
      o.srv.fakeBackend.sessions.some(
        (s) =>
          s.opts.agentId === id &&
          s.sent.some((m) => m.text.includes("HELD-1")),
      );
    await am.holdAgentForMove(id);
    am.enqueueMessage(id, {
      sender: { kind: "user", username: "tester" },
      text: "HELD-1",
    });
    // A change on one host runs newConversation, which flushes the queue.
    expect(
      await am.setManager(id, o.bob.id, o.bob.username, "test"),
    ).toBeTruthy();
    await Bun.sleep(100);
    expect(sentHeld()).toBe(false);
    am.releaseAgentMove(id);
    for (let i = 0; i < 300 && !sentHeld(); i++) await Bun.sleep(5);
    expect(sentHeld()).toBe(true);
  });

  // MUTANT: afterFields before the write, or no afterFields (dies on the
  // userId each saw); the folder not applied (dies on cwd). The plain write
  // to Bob is refused by setManager's own host check, before the guard, so
  // it cannot show an allowance left set: that is the synchronous
  // try/finally around updateAgent, checked by reading.
  it("writes the fields between the two hooks, applies the new folder, and lets only that one write cross hosts", async () => {
    const o = await office();
    const am = o.srv.agentManager;
    const id = o.officeAgent.id;
    const ownerId = getUserByName(o.owner.username)!.id;
    const home = realpathSync(mkdtempSync(join(tmpdir(), "member-reach-")));
    folders.push(home);
    const from = am.getAgent(id)!.cwd;
    const seen: (string | null | undefined)[] = [];
    const change = (over: Partial<AgentHostChange> = {}): AgentHostChange => ({
      from: ownerId,
      to: o.alice.id,
      beforeFields: () => void seen.push(am.getAgent(id)!.userId),
      afterFields: () => void seen.push(am.getAgent(id)!.userId),
      cwd: { from, to: home },
      appsStayed: [],
      ...over,
    });
    // A throw in the hook before the fields leaves them as they were.
    const before = stateOf(o, id);
    const threw = await am
      .setManager(
        id,
        o.alice.id,
        o.alice.username,
        "test",
        change({
          beforeFields: () => {
            throw new Error("pins failed");
          },
        }),
      )
      .then(
        () => "returned",
        () => "threw",
      );
    expect(threw).toBe("threw");
    expect(stateOf(o, id)).toEqual(before);
    const info = await am.setManager(
      id,
      o.alice.id,
      o.alice.username,
      "test",
      change(),
    );
    expect(info && typeof info === "object" ? info.userId : info).toBe(
      o.alice.id,
    );
    expect(seen).toEqual([ownerId, o.alice.id]);
    expect(am.getAgent(id)!.cwd).toBe(home);
    // The allowance was for that one write: a plain change to Bob (the
    // office's host) is still refused.
    await am.setManager(id, o.bob.id, o.bob.username, "test").catch(() => null);
    expect(am.getAgent(id)!.userId).toBe(o.alice.id);
  });

  // MUTANT: reassignKilledAgents without the host check (the history
  // writer's assertion throws).
  it("leaves a killed agent with its manager when the heir is on another host", async () => {
    const o = await office();
    const am = o.srv.agentManager;
    const bobs = await o.spawn("Bob's agent", o.bob);
    await am.kill(bobs.id);
    expect(am.killedAgentManagerUserId(bobs.id)).toBe(o.bob.id);
    expect(
      am.reassignKilledAgents(o.bob.id, {
        userId: o.alice.id,
        manager: o.alice.username,
      }),
    ).toEqual([]);
    expect(am.killedAgentManagerUserId(bobs.id)).toBe(o.bob.id);
    // On one host it moves.
    expect(
      am.reassignKilledAgents(o.bob.id, {
        userId: getUserByName(o.owner.username)!.id,
        manager: o.owner.username,
      }),
    ).toEqual([bobs.id]);
  });
});

// Part 3a: a job's folder is checked and stored on its owner's host. Alice's
// `~` is her home, and a folder she has not got is refused through her
// host; the owner's job is checked as before.
describe("the folder of a new schedule", () => {
  // MUTANT: the cron validateCwd dep as the office's validateCwd (dies on
  // Alice's missing folder: the office stat of a path under her home), or
  // jobFolder as resolveCwd (dies on her `~`).
  it("of Alice is checked and stored on her host; the owner's as before", async () => {
    const o = await office();
    const create = (auth: Auth, cwd: string) =>
      call(o.srv, "POST", "/api/cronjobs", auth, {
        name: "Folder job",
        prompt: "do it",
        schedule: { type: "interval", minutes: 60 },
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "default",
        cwd,
      });
    const mine = await create(o.alice.auth, "~");
    expect(mine.status).toBe(201);
    const cwdOf = (body: unknown) => {
      const b = body as { cwd?: string; cronjob?: { cwd?: string } };
      return b.cronjob?.cwd ?? b.cwd;
    };
    expect(cwdOf(mine.body)).toBe(iso!.home);
    // A folder in her home that the office's home has not got.
    mkdirSync(join(iso!.home, "reach-sub"));
    const sub = await create(o.alice.auth, "~/reach-sub");
    expect([sub.status, cwdOf(sub.body)]).toEqual([
      201,
      join(iso!.home, "reach-sub"),
    ]);
    const missing = await create(o.alice.auth, "~/not-there");
    expect([missing.status, missing.code]).toEqual([400, "invalid_cwd"]);
    const owners = await create(o.ownerAuth, "~");
    expect(owners.status).toBe(201);
    expect([
      typeof cwdOf(owners.body),
      cwdOf(owners.body) === iso!.home,
    ]).toEqual(["string", false]);
  });
});

// Task 12c796b2: the reach limits keep a member off other OS users. Members
// on one OS user already share every file, so an agent of another member on
// the same user is theirs to use; an owner with their own OS user keeps
// every owner route.
describe("members on one OS user, and an owner with their own OS user", () => {
  const recorded: string[] = [];
  afterEach(() => {
    for (const id of recorded.splice(0)) forgetMemberOsUser(id);
  });
  // Bob's agent, and Carol's on another OS user, are spawned before their
  // records: the rule reads the records, not where the agent runs.
  async function shared() {
    const o = await office();
    const bobAgent = await o.spawn("Bob worker", o.bob);
    const carol = await o.srv.seedMember("ReachCarol");
    const carolId = getUserByName(carol.username)!.id;
    const access = await call(
      o.srv,
      "PUT",
      `/api/users/${carol.username}/access`,
      o.ownerAuth,
      { allowedRooms: [o.room.id] },
    );
    expect(access.status).toBe(200);
    const carolAgent = await o.spawn("Carol worker", {
      username: carol.username,
      id: carolId,
    });
    const aliceUser = memberOsUserState(o.alice.id);
    if (aliceUser.kind !== "isolated") throw new Error("Alice is not isolated");
    recorded.push(o.bob.id, carolId);
    recordMemberOsUser(o.bob.id, aliceUser.osUser);
    recordMemberOsUser(carolId, {
      name: "isomux-reach-carol",
      uid: aliceUser.osUser.uid + 1,
    });
    // Bob's runner is Alice's (the fixture's stand-in answers every connect).
    expect(await connectMemberHost(o.bob.id)).toBe(true);
    return { ...o, bobAgent, carolAgent };
  }

  // MUTANT: ownsAgent without the same-OS-user branch (dies on Alice's
  // first row).
  it("lets Alice edit and instruct an agent of Bob, who runs as her OS user, but not one of Carol, who runs as another", async () => {
    const o = await shared();
    // The instructions write needs the version of a read (the owner's).
    const versionOf = async (id: string) => {
      const read = await call(
        o.srv,
        "GET",
        `/api/agents/${id}/instructions`,
        o.ownerAuth,
      );
      expect(read.status).toBe(200);
      return (read.body as { version: string }).version;
    };
    const rows = async (id: string): Promise<[string, string, unknown][]> => [
      [
        "PUT",
        `/api/agents/${id}/instructions`,
        { instructions: "use the cache", version: await versionOf(id) },
      ],
      ["PATCH", `/api/agents/${id}`, { permissionMode: "bypassPermissions" }],
    ];
    for (const [method, path, body] of await rows(o.bobAgent.id)) {
      const alice = await call(o.srv, method, path, o.alice.auth, body);
      expect([`${method} ${path}`, alice.status < 300, alice.code]).toEqual([
        `${method} ${path}`,
        true,
        undefined,
      ]);
    }
    // The control: Carol runs as another OS user.
    for (const [method, path, body] of await rows(o.carolAgent.id)) {
      const alice = await call(o.srv, method, path, o.alice.auth, body);
      expect([`${method} ${path}`, alice.status, alice.code]).toEqual([
        `${method} ${path}`,
        403,
        "member_reach",
      ]);
    }
    // And the office's agent stays out of reach for both of them.
    for (const auth of [o.alice.auth, o.bob.auth]) {
      const office = await call(
        o.srv,
        "PATCH",
        `/api/agents/${o.officeAgent.id}`,
        auth,
        { permissionMode: "bypassPermissions" },
      );
      expect([office.status, office.code]).toEqual([403, "member_reach"]);
    }
  });

  // MUTANT: memberIsolated true for an owner (dies on the office variable).
  it("leaves an owner with their own OS user every owner route and the office's agent", async () => {
    const o = await office();
    const owner = getUserByName("ReachNil")!;
    recorded.push(owner.id);
    recordMemberOsUser(owner.id, { name: "isomux-reach-nil", uid: 2_000_123 });
    const env = await call(
      o.srv,
      "PUT",
      "/api/office/env/REACH_OWNER_VAR",
      o.ownerAuth,
      { value: "1" },
    );
    expect([env.status < 300, env.code]).toEqual([true, undefined]);
    const read = await call(
      o.srv,
      "GET",
      `/api/agents/${o.officeAgent.id}/instructions`,
      o.ownerAuth,
    );
    expect(read.status).toBe(200);
    const edit = await call(
      o.srv,
      "PUT",
      `/api/agents/${o.officeAgent.id}/instructions`,
      o.ownerAuth,
      {
        instructions: "office rules",
        version: (read.body as { version: string }).version,
      },
    );
    expect([edit.status < 300, edit.code]).toEqual([true, undefined]);
    // The enabling condition: the owner is recorded on their own OS user.
    expect(memberOsUserState(owner.id).kind).toBe("isolated");
  });
});
