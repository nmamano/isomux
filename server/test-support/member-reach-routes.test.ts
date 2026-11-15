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
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "../member-os-users.ts";
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

// Part 3d: a manager change between hosts (office <-> member, member <->
// member) is refused with 409 member_os_user and changes nothing; a change
// on one host still moves the agent.
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

  // MUTANT: transferAgentManager and setManager without the host check
  // (the writer's assertion then throws: 500, not 409); the check after the
  // clamp (dies on access: the agent moved down to Alice's ceiling).
  it("is refused office->Alice and Alice->Bob, with no field, token or clamp change; office->Bob moves", async () => {
    const o = await office();
    // Alice's pack ceiling would move a Standard agent down: a refused
    // change must not.
    const pack = await call(
      o.srv,
      "PUT",
      `/api/users/${o.alice.username}/access`,
      o.ownerAuth,
      { allowedRooms: [o.room.id], pack: PACK },
    );
    expect(pack.status).toBe(200);
    const aliceAgent = await o.spawn("Alice's agent", o.alice);
    // The enabling condition: the clamp would apply to Alice.
    expect(o.srv.agentManager.getAgent(o.officeAgent.id)!.access).not.toBe(
      "office",
    );
    await refused(o, o.officeAgent.id, o.alice.id);
    await refused(o, aliceAgent.id, o.bob.id);
    const moved = await setManager(o, o.officeAgent.id, o.bob.id);
    expect(moved.status).toBe(200);
    expect(o.srv.agentManager.getAgent(o.officeAgent.id)!.userId).toBe(
      o.bob.id,
    );
  });

  // MUTANT: agentHostIdentity by "isolated" state only (dies on the
  // not-ready and malformed entries and on the broken file).
  it("counts a not-ready, a malformed and an unreadable record as the member's own host", async () => {
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
      // An unreadable file: every change between two members is refused,
      // also between the owner and Bob, who have no OS user. The route
      // refuses the owner first (2c counts them as isolated), so the
      // manager's own check is called here.
      writeFileSync(memberOsUsersPath(), "{");
      reloadMemberOsUsers();
      const before = stateOf(o, o.officeAgent.id);
      expect(
        await o.srv.agentManager.setManager(
          o.officeAgent.id,
          o.bob.id,
          o.bob.username,
          "test",
        ),
      ).toBe("other_host");
      expect(stateOf(o, o.officeAgent.id)).toEqual(before);
    } finally {
      writeFileSync(memberOsUsersPath(), saved);
      reloadMemberOsUsers();
    }
    // Repaired: the same change moves.
    expect((await setManager(o, o.officeAgent.id, o.bob.id)).status).toBe(200);
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
