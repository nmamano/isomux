// The admin.sock verbs of isomux-member-user (server/member-user-admin.ts,
// internal-docs/member-os-user-design.md 2.2-2.3; slice 1b-ii-a of task
// b94dfd25). The properties: only root reaches them, and only when the rig
// gate is on; an owner never gets an OS user; the OS user named by root is
// checked against the user database (name, uid, never root or the office);
// go-on waits for a late runner and undoes only what it did; disable and an
// undone go-on leave no host, no retry and no record behind; go-on forgets
// the kept code verdict of that identity.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startAdminSocket } from "./admin-socket.ts";
import {
  handleMemberUserAdmin,
  memberSlug,
  memberUsersSupport,
  setMemberUserAdminDeps,
  type MemberUserAdminDeps,
} from "./member-user-admin.ts";
import {
  connectMemberHost,
  hostFor,
  memberCodeTreeChecks,
  memberHostRefusal,
  resetMemberHosts,
  setMemberHostDeps,
  type MemberCheckInput,
} from "./member-hosts.ts";
import {
  memberOsUsersPath,
  memberOsUserState,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "./member-os-users.ts";
import {
  localAgentHost,
  officeAgentHost,
  type AgentHost,
} from "./agent-host.ts";
import { memberSharePath } from "./member-runtime.ts";
import { createMember, deleteUserById, getUserByName } from "./users.ts";
import {
  memberOsUserView,
  memberUserSupport,
  noteMemberUserAttempt,
  resetMemberUserAttempts,
} from "./member-os-user-view.ts";

const OFFICE_UID = 1000;
const MEMBER_UID = 2001;
const MEMBER_GID = 3001;
const PREFIX = "/admin/member-user/";

let dir: string;
let prepared: { share: string; gid: number }[];
let connects: string[];
// The members this file made, deleted after each test: a member left in the
// users store breaks later files in the same bun process.
const created: string[] = [];

function member(name: string, role: "member" | "owner" = "member"): string {
  const known = getUserByName(name);
  if (known) return known.id;
  const made = createMember(name, { role });
  if (!made.ok) throw new Error(made.error);
  created.push(made.user.id);
  return made.user.id;
}

// The verbs with the gate on and every effect recorded. `connect` answers
// each go-on connect attempt in order (the last repeats).
function deps(
  over: Partial<MemberUserAdminDeps> & { answers?: boolean[] } = {},
) {
  const answers = over.answers ?? [true];
  let tries = 0;
  setMemberUserAdminDeps({
    support: { ok: true, shape: "installer" },
    officeUid: OFFICE_UID,
    lookupUser: (name) => {
      if (
        name !== "isomux-alice" &&
        name !== "isomux-root" &&
        name !== "isomux-office"
      )
        throw new Error(`id: ${name}: no such user`);
      const uid =
        name === "isomux-root"
          ? 0
          : name === "isomux-office"
            ? OFFICE_UID
            : MEMBER_UID;
      return { uid, gid: MEMBER_GID, groups: [MEMBER_GID] };
    },
    prepare: async (share, gid) => {
      prepared.push({ share, gid });
      return "a".repeat(64);
    },
    connect: async (userId) => {
      connects.push(userId);
      return answers[Math.min(tries++, answers.length - 1)];
    },
    connectWaitMs: 300,
    connectPollMs: 10,
    ...over,
  });
}

async function call(verb: string, body: unknown) {
  const response = await handleMemberUserAdmin(`${PREFIX}${verb}`, body);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const goOn = (
  memberRef: string,
  osUser = "isomux-alice",
  uid: unknown = MEMBER_UID,
) => call("go-on", { member: memberRef, osUser, uid });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "member-user-admin-"));
  prepared = [];
  connects = [];
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
});

afterEach(() => {
  setMemberUserAdminDeps(null);
  setMemberHostDeps(null);
  resetMemberHosts();
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
  rmSync(dir, { recursive: true, force: true });
  for (const id of created.splice(0)) deleteUserById(id);
  resetMemberUserAttempts();
});

describe("the gate", () => {
  it("answers not_supported to every verb, info included, where the root command cannot run, says why, and changes nothing", async () => {
    const alice = member("Alice");
    const messages = new Set<string>();
    const reasons = [
      "not_linux",
      "kubernetes",
      "render",
      "no_system_install",
      "no_command",
    ] as const;
    for (const reason of reasons) {
      deps({ support: { ok: false, reason } });
      for (const verb of ["info", "prepare", "go-on", "disable"]) {
        const answer = await call(verb, {
          member: alice,
          osUser: "isomux-alice",
          uid: MEMBER_UID,
        });
        expect([reason, verb, answer.status, answer.body.error]).toEqual([
          reason,
          verb,
          409,
          "not_supported",
        ]);
        // The root command prints the message.
        expect(typeof answer.body.message).toBe("string");
        messages.add(answer.body.message as string);
      }
    }
    // One message per reason.
    expect(messages.size).toBe(reasons.length);
    expect(prepared).toEqual([]);
    expect(connects).toEqual([]);
    expect(memberOsUserState(alice).kind).toBe("none");
    // The enabling condition: where it can run, info answers.
    deps();
    expect((await call("info", { member: alice })).status).toBe(200);
  });

  it("takes the verdict of the office's machine at boot when nothing overrides it", () => {
    setMemberUserAdminDeps(null);
    expect(memberUsersSupport()).toEqual(memberUserSupport());
  });

  it("answers 404 to an unknown verb and 400 to a body that is not an object", async () => {
    deps();
    expect((await call("enable", { member: "Alice" })).status).toBe(404);
    expect((await call("../owner-login", { member: "Alice" })).status).toBe(
      404,
    );
    for (const body of [null, "Alice", ["Alice"], 7])
      expect((await call("info", body)).status).toBe(400);
    expect((await call("info", { member: "Nobody" })).status).toBe(404);
  });
});

describe("info", () => {
  it("names the member by id or name, with the default user name's slug and the OS user", async () => {
    const alice = member("Alice Ödön-Smith");
    deps();
    const byName = await call("info", { member: "Alice Ödön-Smith" });
    expect(byName.body).toMatchObject({
      ok: true,
      userId: alice,
      role: "member",
      osUser: null,
      state: "none",
    });
    expect((await call("info", { member: alice })).body.userId).toBe(alice);
    recordMemberOsUser(alice, { name: "isomux-alice", uid: MEMBER_UID });
    const isolated = await call("info", { member: alice });
    expect(isolated.body.osUser).toEqual({
      name: "isomux-alice",
      uid: MEMBER_UID,
    });
    expect(isolated.body.state).toBe("isolated");
  });

  it("makes a slug that fits a user name: lowercase, dashes, at most 25 characters, never empty", () => {
    for (const name of [
      "Alice",
      "Ödön Smith",
      "  --Bob--  ",
      "李雷",
      "a".repeat(80),
      "x-".repeat(30),
    ]) {
      const slug = memberSlug(name);
      expect(`isomux-${slug}`).toMatch(/^[a-z_][a-z0-9_-]{0,31}$/);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug.endsWith("-")).toBe(false);
    }
    expect(memberSlug("Alice Smith")).toBe("alice-smith");
  });
});

describe("prepare and go-on: who and which OS user", () => {
  it("refuse an owner, both of them", async () => {
    const owner = member("Olivia", "owner");
    deps();
    for (const verb of ["prepare", "go-on"]) {
      const answer = await call(verb, {
        member: owner,
        osUser: "isomux-alice",
        uid: MEMBER_UID,
      });
      expect([verb, answer.status, answer.body.error]).toEqual([
        verb,
        409,
        "member_owner",
      ]);
    }
    expect(prepared).toEqual([]);
    expect(memberOsUserState(owner).kind).toBe("none");
  });

  it("refuse a name that is not a user name before any lookup or write", async () => {
    const alice = member("Alice");
    let lookups = 0;
    deps({
      lookupUser: () => {
        lookups++;
        return { uid: MEMBER_UID, gid: MEMBER_GID, groups: [] };
      },
    });
    for (const osUser of [
      "../../etc",
      "isomux/alice",
      "Isomux",
      "",
      "-alice",
      "a".repeat(33),
      7,
      null,
      "alice\n",
    ]) {
      for (const verb of ["prepare", "go-on"]) {
        const answer = await call(verb, {
          member: alice,
          osUser,
          uid: MEMBER_UID,
        });
        expect([
          verb,
          String(osUser),
          answer.status,
          answer.body.error,
        ]).toEqual([verb, String(osUser), 400, "bad_os_user"]);
      }
    }
    expect(lookups).toBe(0);
    expect(prepared).toEqual([]);
    expect(memberOsUserState(alice).kind).toBe("none");
  });

  it("take the uid and gid from the user database: an unknown user, another uid, root and the office are refused", async () => {
    const alice = member("Alice");
    deps();
    const cases: [string, unknown, number, string][] = [
      ["isomux-nobody", MEMBER_UID, 404, "no_os_user"],
      ["isomux-alice", MEMBER_UID + 1, 409, "uid_mismatch"],
      ["isomux-alice", String(MEMBER_UID), 409, "uid_mismatch"],
      ["isomux-alice", undefined, 409, "uid_mismatch"],
      ["isomux-root", 0, 409, "privileged_os_user"],
      ["isomux-office", OFFICE_UID, 409, "privileged_os_user"],
    ];
    for (const verb of ["prepare", "go-on"])
      for (const [osUser, uid, status, error] of cases) {
        const answer = await call(verb, { member: alice, osUser, uid });
        expect([verb, osUser, uid, answer.status, answer.body.error]).toEqual([
          verb,
          osUser,
          uid,
          status,
          error,
        ]);
      }
    expect(prepared).toEqual([]);
    expect(memberOsUserState(alice).kind).toBe("none");
  });
});

describe("prepare", () => {
  it("installs into the share of the named user with the gid of the user database", async () => {
    const alice = member("Alice");
    deps();
    const answer = await call("prepare", {
      member: alice,
      osUser: "isomux-alice",
      uid: MEMBER_UID,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, hash: "a".repeat(64) });
    expect(prepared).toEqual([
      { share: memberSharePath("isomux-alice"), gid: MEMBER_GID },
    ]);
    // prepare records nothing.
    expect(memberOsUserState(alice).kind).toBe("none");
  });

  it("answers 500 when the install fails", async () => {
    const alice = member("Alice");
    deps({
      prepare: async () => {
        throw new Error("disk full");
      },
    });
    const answer = await call("prepare", {
      member: alice,
      osUser: "isomux-alice",
      uid: MEMBER_UID,
    });
    expect([answer.status, answer.body.error]).toEqual([500, "prepare_failed"]);
  });
});

describe("go-on", () => {
  it("records the OS user and waits for a runner that comes up late", async () => {
    const alice = member("Alice");
    deps({ answers: [false, false, false, true] });
    const answer = await goOn(alice);
    expect(answer.body).toEqual({ ok: true, ready: true });
    expect(connects.length).toBe(4);
    expect(memberOsUserState(alice)).toMatchObject({
      kind: "isolated",
      osUser: { name: "isomux-alice", uid: MEMBER_UID },
    });
  });

  it("undoes the record when the runner never connects, with the refusal as its reason", async () => {
    const alice = member("Alice");
    deps({ answers: [false] });
    const started = Date.now();
    const answer = await goOn(alice);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(answer.body).toMatchObject({ ok: false, ready: false });
    expect(typeof answer.body.reason).toBe("string");
    expect(connects.length).toBeGreaterThan(2);
    expect(memberOsUserState(alice).kind).toBe("none");
    expect(hostFor(alice)).toBe(officeAgentHost());
  });

  // The real connect: a runner that cannot be reached is refused, and its
  // retry timer is set. The undo must leave no timer that connects later.
  it("leaves no retry behind after an undo, and passes the connect's refusal on", async () => {
    const alice = member("Alice");
    let runnerTries = 0;
    setMemberHostDeps({
      readPeerUid: () => MEMBER_UID,
      lookupUser: () => ({
        uid: MEMBER_UID,
        gid: MEMBER_GID,
        groups: [MEMBER_GID],
      }),
      checks: async () => [],
      checkShare: () => ({ ok: true }),
      runtime: {
        hash: async () => "a".repeat(64),
        install: async () => {},
        prune: async () => {},
      },
      connectRunner: async () => {
        runnerTries++;
        throw new Error("no runner here");
      },
      retryMs: 50,
    });
    deps({ connect: connectMemberHost, connectWaitMs: 100 });
    const answer = await goOn(alice);
    expect(answer.body.ready).toBe(false);
    expect(String(answer.body.reason)).toContain("no runner here");
    // The enabling condition: the connect ran and failed.
    expect(runnerTries).toBeGreaterThan(0);
    const after = runnerTries;
    await Bun.sleep(300);
    expect(runnerTries).toBe(after);
    expect(memberHostRefusal(alice)).toBeUndefined();
    expect(memberOsUserState(alice).kind).toBe("none");
  });

  it("refuses a member who runs as another OS user, and changes nothing", async () => {
    const alice = member("Alice");
    recordMemberOsUser(alice, { name: "isomux-old", uid: 2999 });
    deps();
    const answer = await goOn(alice);
    expect([answer.status, answer.body.error]).toEqual([
      409,
      "already_isolated",
    ]);
    expect(memberOsUserState(alice)).toMatchObject({
      osUser: { name: "isomux-old" },
    });
    expect(connects).toEqual([]);
  });

  // An undo removes only what this go-on made. A member who already ran as
  // this OS user stays isolated when the connect fails: removing the record
  // would move their agents to the office's user.
  it("keeps the record of a member who already ran as this OS user when the connect fails", async () => {
    const alice = member("Alice");
    recordMemberOsUser(alice, { name: "isomux-alice", uid: MEMBER_UID });
    deps({ answers: [false] });
    const answer = await goOn(alice);
    expect(answer.body.ready).toBe(false);
    expect(memberOsUserState(alice).kind).toBe("isolated");
    expect(hostFor(alice)).not.toBe(officeAgentHost());
  });

  // Two members on one OS user would share a home, a runner and their
  // sign-ins.
  // The name and the uid each name the OS user: a match on either refuses.
  it("refuses an OS user that another member runs as, by name or by uid", async () => {
    const alice = member("Alice");
    const bob = member("Bob");
    for (const theirs of [
      { name: "isomux-alice", uid: MEMBER_UID + 7 },
      { name: "isomux-bob", uid: MEMBER_UID },
    ]) {
      recordMemberOsUser(bob, theirs);
      deps();
      const answer = await goOn(alice);
      expect([theirs, answer.status, answer.body.error]).toEqual([
        theirs,
        409,
        "os_user_taken",
      ]);
      expect(memberOsUserState(alice).kind).toBe("none");
      expect(memberOsUserState(bob)).toMatchObject({ osUser: theirs });
      expect(connects).toEqual([]);
    }
  });

  // A malformed entry or file keeps the member off the office user: go-on
  // must neither overwrite it nor remove it in an undo.
  it("refuses a member whose entry or file is broken, and leaves it as it was", async () => {
    const alice = member("Alice");
    for (const text of [
      JSON.stringify({ [alice]: { name: 5 } }),
      "{ not json",
    ]) {
      writeFileSync(memberOsUsersPath(), text);
      reloadMemberOsUsers();
      deps({ answers: [false] });
      const answer = await goOn(alice);
      expect([answer.status, answer.body.error]).toEqual([
        409,
        "broken_record",
      ]);
      expect(readFileSync(memberOsUsersPath(), "utf8")).toBe(text);
      expect(memberOsUserState(alice).kind).toBe("broken");
      expect(connects).toEqual([]);
    }
  });

  it("forgets the kept code verdict of that identity only", async () => {
    const alice = member("Alice");
    const count = join(dir, "walks");
    writeFileSync(count, "");
    setMemberHostDeps({
      codeCheck: {
        command: [
          "sh",
          "-c",
          `cat > /dev/null; echo walk >> ${count}; echo '[]'`,
        ],
        timeoutMs: 5000,
      },
    });
    const input = (uid: number): MemberCheckInput =>
      ({
        officeUid: OFFICE_UID,
        officeGroups: [],
        member: { uid, gid: MEMBER_GID, groups: [MEMBER_GID] },
        privilegedGroups: [],
        officeHome: dir,
        stateRoot: dir,
        codeRoot: join(dir, "code"),
      }) as MemberCheckInput;
    const walks = () =>
      readFileSync(count, "utf8").split("\n").filter(Boolean).length;
    await memberCodeTreeChecks(input(MEMBER_UID));
    await memberCodeTreeChecks(input(MEMBER_UID + 1));
    await memberCodeTreeChecks(input(MEMBER_UID));
    // The enabling condition: both verdicts are kept.
    expect(walks()).toBe(2);
    deps();
    expect((await goOn(alice)).body.ready).toBe(true);
    await memberCodeTreeChecks(input(MEMBER_UID));
    await memberCodeTreeChecks(input(MEMBER_UID + 1));
    expect(walks()).toBe(3);
  });
});

describe("disable", () => {
  // Slice 1c-ii-b: a disable of a member whose runner is not connected
  // moves nothing; with keepFiles it still forgets them (the files stay in
  // their home). The move itself: test-support/member-disable.test.ts.
  it("with keepFiles, removes the record and the host, so the member's agents run on the office host", async () => {
    const alice = member("Alice");
    recordMemberOsUser(alice, { name: "isomux-alice", uid: MEMBER_UID });
    deps();
    // The enabling condition: isolated, never on the office host.
    expect(hostFor(alice)).not.toBe(officeAgentHost());
    expect((await call("disable", { member: alice })).body.error).toBe(
      "not_connected",
    );
    expect(memberOsUserState(alice).kind).toBe("isolated");
    expect(
      (await call("disable", { member: alice, keepFiles: true })).body,
    ).toEqual({
      ok: true,
      kept: true,
    });
    expect(memberOsUserState(alice).kind).toBe("none");
    expect(hostFor(alice)).toBe(officeAgentHost());
  });
});

describe("admin.sock", () => {
  let socket: { stop(): void } | null = null;
  afterEach(() => {
    socket?.stop();
    socket = null;
  });

  async function post(peerUid: number | null, recovery?: string) {
    const socketPath = join(dir, "admin.sock");
    socket = startAdminSocket({
      socketPath,
      serverUid: process.getuid!(),
      recoveryUidSetting: recovery,
      readPeerUid: () => peerUid,
    });
    expect(socket).not.toBeNull();
    const response = await fetch("http://localhost/admin/member-user/info", {
      method: "POST",
      unix: socketPath,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: member("Alice") }),
    } as RequestInit);
    socket!.stop();
    socket = null;
    return response.status;
  }

  it("answers root only: not the recovery uid, not the office's uid, not another uid", async () => {
    deps();
    expect(await post(0)).toBe(200);
    // The recovery uid may log an owner in, but not make OS users.
    expect(await post(4321, "4321")).toBe(403);
    expect(await post(process.getuid!())).toBe(403);
    expect(await post(5555)).toBe(403);
    expect(await post(null)).toBe(403);
  });
});

// Keep the record path inside the test state root (never the office's).
it("the record lives under the test state root, and the office host is the local one", () => {
  expect(memberOsUsersPath()).not.toContain("/.isomux/");
  expect(officeAgentHost()).toBe(localAgentHost as AgentHost);
});

// Slice 1c-ii-a: go-on moves the member's files. Each step is a dep, so a
// recording fake shows the order and each step can fail in turn.
describe("go-on moves the member's files", () => {
  let steps: string[];
  // Every pending hold: a second go-on that holds again is released too, so
  // a red run fails on its assertion and does not hang.
  let holds: (() => void)[];
  let releaseHold: () => void;
  // The record state each step saw.
  let seen: Record<string, string>;
  const MOVE_HOST = { kind: "runner" } as unknown as AgentHost;
  const PLAN = {
    userId: "",
    trees: [{ src: "/x", destParts: ["x"] }],
    codex: [],
    claude: [],
  };

  function moveDeps(
    alice: string,
    fail?: string,
    answers: boolean[] = [true],
    extra: Partial<MemberUserAdminDeps> = {},
  ) {
    steps = [];
    seen = {};
    holds = [];
    releaseHold = () => holds.splice(0).forEach((resolve) => resolve());
    let tries = 0;
    const step = (name: string) => {
      steps.push(name);
      seen[name] = memberOsUserState(alice).kind;
      if (name === fail) throw new Error(`${name} failed`);
    };
    deps({
      connect: async () => {
        step("connect");
        return answers[Math.min(tries++, answers.length - 1)];
      },
      holdMember: async () => {
        steps.push("hold");
        await new Promise<void>((resolve) => holds.push(resolve));
        steps.push("held");
      },
      releaseMember: () => void steps.push("release"),
      memberAgents: () => [],
      planMove: () => (step("plan"), PLAN),
      moveHost: () => (
        step("moveHost"),
        fail === "noHost" ? undefined : MOVE_HOST
      ),
      stageMove: async () => {
        step("stage");
        return {
          pins: [],
          undo: async () => void steps.push("undo"),
          done: async () => void steps.push("done"),
          deleteOfficeCopies: () => step("delete"),
        };
      },
      applyPins: () => step("pins"),
      ...extra,
    });
  }

  // go-on, with the hold released only after a pause in which nothing may
  // be planned (D1).
  async function goOnHeld(alice: string) {
    const answer = goOn(alice);
    for (let i = 0; i < 200 && !steps.includes("hold"); i++) await Bun.sleep(1);
    await Bun.sleep(20);
    expect(steps).toEqual(["hold"]);
    releaseHold();
    return answer;
  }

  it("holds first, plans after the hold, records before the connect, pins only after the stage, and releases before the delete", async () => {
    const alice = member("Alice");
    moveDeps(alice);
    const answer = await goOnHeld(alice);
    expect(answer.body).toMatchObject({ ok: true, ready: true });
    expect(steps).toEqual([
      "hold",
      "held",
      "plan",
      "connect",
      "moveHost",
      "stage",
      "pins",
      "done",
      "release",
      "delete",
    ]);
    expect(seen.plan).toBe("none");
    for (const name of ["connect", "stage", "pins"])
      expect([name, seen[name]]).toEqual([name, "isolated"]);
    expect(memberOsUserState(alice).kind).toBe("isolated");
  });

  for (const fail of ["plan", "connect", "noHost", "stage", "pins"]) {
    it(`undoes everything after a failure at ${fail}, and keeps the office copy`, async () => {
      const alice = member("Alice");
      moveDeps(
        alice,
        fail === "connect" ? undefined : fail,
        fail === "connect" ? [false] : [true],
      );
      const answer = await goOnHeld(alice);
      expect(answer.body).toMatchObject({ ok: false, ready: false });
      // A failed stage has undone its own side; a failure after it needs
      // the staged move's undo.
      expect(steps.filter((s) => s === "undo")).toHaveLength(
        fail === "pins" ? 1 : 0,
      );
      expect(steps).not.toContain("delete");
      expect(steps).not.toContain("done");
      expect(steps.filter((s) => s === "release")).toHaveLength(1);
      expect(steps.at(-1)).toBe("release");
      expect(memberOsUserState(alice).kind).toBe("none");
    });
  }

  it("keeps the record of a member already isolated as this user when a rerun fails", async () => {
    const alice = member("Alice");
    recordMemberOsUser(alice, { name: "isomux-alice", uid: MEMBER_UID });
    moveDeps(alice, "pins");
    const answer = await goOnHeld(alice);
    expect(answer.body).toMatchObject({ ok: false });
    expect(steps).toContain("undo");
    expect(memberOsUserState(alice).kind).toBe("isolated");
  });

  // D1 (4c-ii): the record says the files move from before the connect
  // until the pins are written, so an office that stops in between keeps
  // the member not ready through a restart (a reload of the record).
  it("marks the record moving from the record to the pins, through a reload, and clears it before the release", async () => {
    const alice = member("Alice");
    moveDeps(alice);
    const unfinished: Record<string, boolean> = {};
    const watch = (name: string, inner: () => unknown) => () => {
      reloadMemberOsUsers();
      const state = memberOsUserState(alice);
      unfinished[name] = state.kind === "isolated" && !!state.unfinished;
      return inner();
    };
    deps({
      connect: watch(
        "connect",
        async () => (steps.push("connect"), true),
      ) as never,
      holdMember: async () => void steps.push("hold"),
      releaseMember: watch(
        "release",
        () => void steps.push("release"),
      ) as never,
      memberAgents: () => [],
      planMove: () => PLAN,
      moveHost: () => MOVE_HOST,
      stageMove: async () => ({
        pins: [],
        undo: async () => {},
        done: async () => {},
        deleteOfficeCopies: () => {},
      }),
      applyPins: watch("pins", () => void steps.push("pins")) as never,
    });
    const answer = await goOn(alice);
    expect(answer.body).toMatchObject({ ok: true, ready: true });
    expect(unfinished).toEqual({ connect: true, pins: true, release: false });
    reloadMemberOsUsers();
    expect(memberOsUserState(alice)).toEqual({
      kind: "isolated",
      osUser: { name: "isomux-alice", uid: MEMBER_UID },
    });
  });

  it("clears the mark of an unfinished move when the rerun succeeds, also with nothing left to move", async () => {
    const alice = member("Alice");
    recordMemberOsUser(
      alice,
      { name: "isomux-alice", uid: MEMBER_UID },
      { moving: true },
    );
    for (const plan of [PLAN, { ...PLAN, trees: [] }]) {
      moveDeps(alice, undefined, [true], { planMove: () => plan });
      expect((await goOnHeld(alice)).body).toMatchObject({ ok: true });
      reloadMemberOsUsers();
      const state = memberOsUserState(alice);
      expect({
        trees: plan.trees.length,
        unfinished: state.kind === "isolated" && state.unfinished,
      }).toEqual({
        trees: plan.trees.length,
        unfinished: undefined,
      });
      recordMemberOsUser(
        alice,
        { name: "isomux-alice", uid: MEMBER_UID },
        { moving: true },
      );
    }
  });

  it("puts the mark back as it was when a rerun fails: unfinished stays unfinished, finished stays finished", async () => {
    const alice = member("Alice");
    for (const before of [true, false]) {
      recordMemberOsUser(
        alice,
        { name: "isomux-alice", uid: MEMBER_UID },
        { moving: before },
      );
      moveDeps(alice, "pins");
      expect((await goOnHeld(alice)).body).toMatchObject({ ok: false });
      reloadMemberOsUsers();
      const state = memberOsUserState(alice);
      expect({ before, state }).toEqual({
        before,
        state: {
          kind: "isolated",
          osUser: { name: "isomux-alice", uid: MEMBER_UID },
          ...(before ? { unfinished: true } : {}),
        },
      });
    }
  });

  // F1 (4c-ii round 1): the root command undoes the OS user, its home
  // included, on every go-on answer that is not ready, unless the answer
  // says that the office keeps its record. The record cannot be written:
  // a folder in place of its temporary file.
  const blockRecord = () =>
    mkdirSync(`${memberOsUsersPath()}.${process.pid}.tmp`, { recursive: true });
  const unblockRecord = () =>
    rmSync(`${memberOsUsersPath()}.${process.pid}.tmp`, {
      recursive: true,
      force: true,
    });

  it("tells the root command that it keeps the record when the files moved but the mark cannot be cleared", async () => {
    const alice = member("Alice");
    moveDeps(alice, undefined, [true], {
      applyPins: () => (steps.push("pins"), blockRecord()),
    });
    try {
      const answer = await goOnHeld(alice);
      expect(answer.body).toMatchObject({
        ok: false,
        ready: false,
        kept: true,
      });
    } finally {
      unblockRecord();
    }
    // The enabling condition: the record still says the files move.
    reloadMemberOsUsers();
    const state = memberOsUserState(alice);
    expect(state.kind === "isolated" && state.unfinished).toBe(true);
  });

  it("tells the root command that it keeps the record when a failed first go-on cannot remove it", async () => {
    const alice = member("Alice");
    moveDeps(alice, undefined, [true], {
      stageMove: async () => {
        steps.push("stage");
        blockRecord();
        throw new Error("stage failed");
      },
    });
    try {
      const answer = await goOnHeld(alice);
      expect(answer.body).toMatchObject({
        ok: false,
        ready: false,
        kept: true,
      });
    } finally {
      unblockRecord();
    }
    reloadMemberOsUsers();
    expect(memberOsUserState(alice).kind).toBe("isolated");
  });

  it("says nothing is kept when a failed first go-on removed its record", async () => {
    const alice = member("Alice");
    moveDeps(alice, "stage");
    const answer = await goOnHeld(alice);
    expect(answer.body).toMatchObject({ ok: false, ready: false });
    expect(answer.body.kept).toBeUndefined();
    expect(memberOsUserState(alice).kind).toBe("none");
  });

  it("refuses a second go-on while the member's files move, and holds nothing for it", async () => {
    const alice = member("Alice");
    moveDeps(alice);
    const first = goOn(alice);
    for (let i = 0; i < 200 && !steps.includes("hold"); i++) await Bun.sleep(1);
    // A second go-on that waits on a hold of its own answers nothing in time.
    const second = await Promise.race([
      goOn(alice),
      Bun.sleep(300).then(() => null),
    ]);
    const holdsAsked = steps.filter((s) => s === "hold").length;
    releaseHold();
    expect(second?.body.ok).toBe(false);
    expect(holdsAsked).toBe(1);
    expect((await first).body).toMatchObject({ ok: true, ready: true });
  });

  it("holds nothing when go-on refuses (another OS user, a taken user)", async () => {
    const alice = member("Alice");
    const bob = member("Bob");
    recordMemberOsUser(bob, { name: "isomux-alice", uid: MEMBER_UID });
    moveDeps(alice);
    expect((await goOn(alice)).body.error).toBe("os_user_taken");
    recordMemberOsUser(alice, { name: "isomux-other", uid: 2002 });
    expect((await goOn(alice)).body.error).toBe("already_isolated");
    expect(steps).toEqual([]);
  });
});

// Task b94dfd25 4c-i: what the owner's page hears of the root command. The
// verbs tell the page what the command does for a member: prepare and go-on
// are an enable, disable a disable, info nothing. A refusal or a failed move
// shows its reason; nothing is heard while the gate is closed.
describe("what the owner's page hears", () => {
  const attemptOf = (userId: string) =>
    memberOsUserView(
      { id: userId, role: "member" },
      { support: { ok: false, reason: "no_system_install" } },
    ).attempt;

  it("an enable reads running from prepare through go-on, and nothing once go-on succeeds", async () => {
    const alice = member("Alice");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    deps({
      connect: async (userId) => {
        connects.push(userId);
        await held;
        return true;
      },
    });
    const prepared = await call("prepare", {
      member: alice,
      osUser: "isomux-alice",
      uid: MEMBER_UID,
    });
    expect(prepared.status).toBe(200);
    expect(attemptOf(alice)).toMatchObject({
      action: "enable",
      status: "running",
    });
    // go-on says running itself, also with no prepare heard before it (a
    // restart in between).
    resetMemberUserAttempts();
    const pending = goOn(alice);
    // The enabling condition: go-on is in its connect.
    for (let i = 0; i < 100 && connects.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(connects.length).toBeGreaterThan(0);
    expect(attemptOf(alice)).toMatchObject({
      action: "enable",
      status: "running",
    });
    release();
    expect((await pending).body).toEqual({ ok: true, ready: true });
    expect(attemptOf(alice)).toBeUndefined();
  });

  it("a go-on that fails shows the office's reason", async () => {
    const alice = member("Alice");
    deps({ answers: [false] });
    const answer = await goOn(alice);
    expect(answer.body).toMatchObject({ ok: false, ready: false });
    const reason = answer.body.reason as string;
    expect(reason.length).toBeGreaterThan(0);
    expect(attemptOf(alice)).toMatchObject({
      action: "enable",
      status: "failed",
      message: reason,
    });
  });

  it("a refused disable and a failed prepare show their message", async () => {
    const alice = member("Alice");
    recordMemberOsUser(alice, { name: "isomux-alice", uid: MEMBER_UID });
    deps();
    const refused = await call("disable", { member: alice });
    expect(refused.body.error).toBe("not_connected");
    expect(attemptOf(alice)).toMatchObject({
      action: "disable",
      status: "failed",
      message: refused.body.message,
    });
    const bob = member("Bob");
    deps({
      prepare: async () => {
        throw new Error("disk full");
      },
    });
    const failed = await call("prepare", {
      member: bob,
      osUser: "isomux-alice",
      uid: MEMBER_UID,
    });
    expect(failed.status).toBe(500);
    expect(attemptOf(bob)).toMatchObject({
      action: "enable",
      status: "failed",
      message: failed.body.message,
    });
  });

  it("info changes nothing, and nothing is heard while the gate is closed", async () => {
    const alice = member("Alice");
    deps();
    expect((await call("info", { member: alice })).status).toBe(200);
    expect(attemptOf(alice)).toBeUndefined();
    // The command reads info first: it leaves an earlier failure as it was.
    noteMemberUserAttempt(alice, "enable", "failed", "earlier");
    expect((await call("info", { member: alice })).status).toBe(200);
    expect(attemptOf(alice)).toMatchObject({
      status: "failed",
      message: "earlier",
    });
    resetMemberUserAttempts();
    deps({ support: { ok: false, reason: "no_system_install" } });
    for (const verb of ["prepare", "go-on", "disable"]) {
      const answer = await call(verb, {
        member: alice,
        osUser: "isomux-alice",
        uid: MEMBER_UID,
      });
      expect({ verb, status: answer.status }).toEqual({ verb, status: 409 });
      expect({ verb, attempt: attemptOf(alice) }).toEqual({
        verb,
        attempt: undefined,
      });
    }
  });
});
