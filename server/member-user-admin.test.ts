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
  claimMemberMoves,
  handleMemberUserAdmin,
  memberPlaceRunning,
  releaseMemberMoves,
  memberUsersSupport,
  setMemberUserAdminDeps,
  type MemberUserAdminDeps,
  type MovedInDeps,
} from "./member-user-admin.ts";
import {
  connectMemberHost,
  hostFor,
  memberIsMoving,
  memberCodeTreeChecks,
  memberHostRefusal,
  resetMemberHosts,
  setMemberHostDeps,
  type MemberCheckInput,
} from "./member-hosts.ts";
import { STATE_ROOT } from "./config.ts";
import { resetStateRoot } from "./test-support/temp-state.ts";
import {
  MEMBER_OS_UID_TIES_FILE,
  memberOsUidTies,
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
    // No names taken: a test reads no passwd of this box.
    takenOsUserNames: async () => [],
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
  // An empty office: an earlier file in the same bun process can leave a
  // member with this file's names, and office files (a provider home) that
  // make go-on plan a move.
  resetStateRoot(STATE_ROOT);
  reloadMemberOsUsers();
});

afterEach(() => {
  setMemberUserAdminDeps(null);
  setMemberHostDeps(null);
  resetMemberHosts();
  rmSync(memberOsUsersPath(), { force: true });
  // A tie outlives its entry: clear it, or a uid an earlier test recorded
  // stays tied.
  rmSync(join(STATE_ROOT, MEMBER_OS_UID_TIES_FILE), { force: true });
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
  it("names the member by id or name, with the OS user", async () => {
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

  // Task 3b5234dc: userName is the default name of a new user for the
  // command line with no --user, the same name the page shows: the member's
  // own name, or the next free one.
  it("gives the member's name as the new user's name while it is free, and the next free name while it is taken", async () => {
    member("Alice Ödön-Smith");
    const userName = async (taken: string[] | null) => {
      deps({ takenOsUserNames: async () => taken });
      return (await call("info", { member: "Alice Ödön-Smith" })).body.userName;
    };
    expect(await userName([])).toBe("alice-odon-smith");
    expect(await userName(null)).toBe("alice-odon-smith");
    expect(await userName(["alice-odon-smith"])).toBe("alice-odon-smith2");
    expect(
      await userName(["alice-odon-smith", "alice-odon-smith2", "bob"]),
    ).toBe("alice-odon-smith3");
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

  // Task abdb452b: an agent's host move shares the go-on/disable busy set,
  // both ways. MUTANT: claimMemberMoves on a set of its own (dies on the
  // go-on and disable refusals and on the claim during a go-on); a claim
  // that keeps the free members of a refused claim (dies on Bob's claim).
  it("shares one busy set with an agent's host move, both ways, and claims all or nothing", async () => {
    const alice = member("Alice");
    const bob = member("Bob");
    moveDeps(alice);
    expect(claimMemberMoves([alice])).toBe(true);
    try {
      const refusedGoOn = await goOn(alice);
      expect([refusedGoOn.status, refusedGoOn.body.error]).toEqual([
        409,
        "move_in_progress",
      ]);
      const refusedDisable = await call("disable", { member: alice });
      expect([refusedDisable.status, refusedDisable.body.error]).toEqual([
        409,
        "move_in_progress",
      ]);
      expect(steps).toEqual([]);
      // Alice is busy: a claim of Bob and Alice takes neither.
      expect(claimMemberMoves([bob, alice])).toBe(false);
      expect(claimMemberMoves([bob])).toBe(true);
      releaseMemberMoves([bob]);
    } finally {
      releaseMemberMoves([alice]);
    }
    // While Alice's go-on runs, a host move cannot claim her.
    const first = goOn(alice);
    for (let i = 0; i < 200 && !steps.includes("hold"); i++) await Bun.sleep(1);
    expect(steps).toEqual(["hold"]);
    expect(claimMemberMoves([alice])).toBe(false);
    releaseHold();
    expect((await first).body).toMatchObject({ ok: true, ready: true });
    // Free again once the go-on answered.
    expect(claimMemberMoves([alice])).toBe(true);
    releaseMemberMoves([alice]);
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

// Slice 5c-2 (task 78733adf, E6 and D1-D9): a member who came with an office
// move. Her record holds the old box's uid and `movedIn` until her go-on
// places the home that waits in the state, as a job; the root command asks
// again until the job's outcome comes back.
describe("go-on of a member who came with an office move", () => {
  const OLD_UID = 1501;
  const OLD_HOME = "/home/isomux-alice";
  const MOVE_HOST = { kind: "runner" } as unknown as AgentHost;
  let steps: string[];
  let places: { onProgress: (placed: number, total: number) => void }[];
  let finishPlace: (error?: Error) => void;
  let stage: string | null;
  let passwdHome: string | null;
  let warnings: string[];
  // What the record said at a step.
  let seen: Record<string, ReturnType<typeof memberOsUserState>>;
  // The place running at each connect (D5).
  let runningAtConnect: boolean[];

  function movedInRecord(userId: string, extra: Record<string, unknown> = {}) {
    writeFileSync(
      memberOsUsersPath(),
      JSON.stringify({
        [userId]: {
          name: "isomux-alice",
          uid: OLD_UID,
          movedIn: { home: OLD_HOME },
        },
        ...extra,
      }),
    );
    reloadMemberOsUsers();
  }

  function movedDeps(
    alice: string,
    over: Partial<MovedInDeps> = {},
    connectError?: Error,
  ) {
    steps = [];
    places = [];
    seen = {};
    runningAtConnect = [];
    stage = join(dir, "move-members", alice, "home");
    mkdirSync(stage, { recursive: true });
    passwdHome = OLD_HOME;
    warnings = ["tunnel.service: no such unit here"];
    const step = (name: string) => {
      steps.push(name);
      seen[name] = memberOsUserState(alice);
    };
    deps({
      connect: async (userId) => {
        step("connect");
        runningAtConnect.push(memberPlaceRunning(userId));
        if (connectError) throw connectError;
        return true;
      },
      holdMember: async () => step("hold"),
      releaseMember: () => step("release"),
      memberAgents: () => [],
      planMove: (userId) => (
        step("plan"),
        { userId, trees: [], codex: [], claude: [] }
      ),
      appsLeave: async () => (step("appsLeave"), []),
      appsArrive: () => step("appsArrive"),
      moveHost: () => MOVE_HOST,
      movedIn: {
        stageDir: () => stage,
        passwdHome: () => passwdHome,
        place: (input) => {
          step("place");
          places.push(input);
          return new Promise<void>((resolve, reject) => {
            finishPlace = (error) => (error ? reject(error) : resolve());
          });
        },
        removeStage: () => step("removeStage"),
        restoreUnits: async () => (step("restoreUnits"), warnings),
        ...over,
      },
    });
  }

  async function until(what: string, test: () => boolean) {
    for (let i = 0; i < 400 && !test(); i++) await Bun.sleep(5);
    expect([what, test()]).toEqual([what, true]);
  }

  const recordText = () => readFileSync(memberOsUsersPath(), "utf8");

  it("info says she came with a move, with her old home", async () => {
    const alice = member("Alice");
    movedInRecord(alice);
    deps();
    const answer = await call("info", { member: alice });
    expect(answer.body).toMatchObject({
      ok: true,
      userId: alice,
      osUser: { name: "isomux-alice", uid: OLD_UID },
      movedIn: true,
      oldHome: OLD_HOME,
    });
  });

  // D1: before the job records the new uid, the record is the move's, not
  // this call's: no `kept`, so the root command removes the user it made.
  for (const [label, set] of [
    [
      "passwd's home differs from her old home",
      () => (passwdHome = "/srv/isomux-alice"),
    ],
    ["her OS user has no home in passwd", () => (passwdHome = null)],
    ["her home did not come with the move", () => (stage = null)],
  ] as [string, () => void][])
    it(`refuses without kept when ${label}, and changes nothing`, async () => {
      const alice = member("Alice");
      movedInRecord(alice);
      movedDeps(alice);
      set();
      const before = recordText();
      const answer = await goOn(alice);
      expect(answer.status).toBe(200);
      expect(answer.body.ok).toBe(false);
      expect(answer.body.ready).toBe(false);
      expect("kept" in answer.body).toBe(false);
      expect(typeof answer.body.reason).toBe("string");
      expect(recordText()).toBe(before);
      expect(memberOsUidTies().map((t) => t.uid)).not.toContain(MEMBER_UID);
      expect(steps.filter((s) => ["connect", "place"].includes(s))).toEqual([]);
      expect(steps.filter((s) => s === "hold").length).toBe(
        steps.filter((s) => s === "release").length,
      );
      expect(memberPlaceRunning(alice)).toBe(false);
    });

  it("runs the place as a job: answers running, records the new uid with movedIn, and answers the progress to a go-on that comes while it runs", async () => {
    const alice = member("Alice");
    movedInRecord(alice);
    movedDeps(alice);
    const first = await goOn(alice);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, ready: false, running: true });
    await until("the place started", () => places.length === 1);
    expect(memberPlaceRunning(alice)).toBe(true);
    // Her runner connects only while her place runs (D5).
    expect(runningAtConnect).toEqual([true]);
    expect(seen.connect).toEqual({
      kind: "isolated",
      osUser: { name: "isomux-alice", uid: MEMBER_UID },
      unfinished: true,
      movedIn: { home: OLD_HOME },
    });
    places[0].onProgress(3, 10);
    const again = await goOn(alice);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      ok: true,
      ready: false,
      running: true,
      placed: 3,
      total: 10,
    });
    expect(places.length).toBe(1);
    // D6: the job is a running call.
    for (const body of [{}, { keepFiles: true }, { deleteMovedHome: true }])
      expect(
        (await call("disable", { member: alice, ...body })).body.error,
      ).toBe("move_in_progress");
    expect(steps).not.toContain("removeStage");
    finishPlace();
    await until("the job ended", () => !memberPlaceRunning(alice));
  });

  it("on success clears movedIn before it removes the stage, brings the units back, and answers ready once to the next go-on", async () => {
    const alice = member("Alice");
    movedInRecord(alice);
    movedDeps(alice);
    await goOn(alice);
    await until("the place started", () => places.length === 1);
    finishPlace();
    await until("the job ended", () => !memberPlaceRunning(alice));
    const order = (name: string) => steps.indexOf(name);
    for (const [a, b] of [
      ["hold", "appsLeave"],
      ["appsLeave", "connect"],
      ["connect", "place"],
      ["place", "removeStage"],
      ["removeStage", "restoreUnits"],
      ["restoreUnits", "appsArrive"],
      ["appsArrive", "release"],
    ])
      expect([a, b, order(a) > -1 && order(a) < order(b)]).toEqual([
        a,
        b,
        true,
      ]);
    // The record no longer says movedIn when the stage goes (a crash between
    // the two leaves a stage the boot sweep removes, never a movedIn member
    // with no stage).
    expect(seen.removeStage).toEqual({
      kind: "isolated",
      osUser: { name: "isomux-alice", uid: MEMBER_UID },
    });
    expect(memberOsUserState(alice)).toEqual({
      kind: "isolated",
      osUser: { name: "isomux-alice", uid: MEMBER_UID },
    });
    const ready = await goOn(alice);
    expect(ready.body).toMatchObject({ ok: true, ready: true });
    expect(ready.body.warnings).toEqual(warnings);
    // D2: the outcome answered; nothing ran again for it.
    expect(places.length).toBe(1);
    expect(steps.filter((s) => s === "hold").length).toBe(1);
  });

  it("on failure keeps movedIn and the new uid, answers the failure with kept once, and the go-on after that starts a new job", async () => {
    const alice = member("Alice");
    movedInRecord(alice);
    movedDeps(alice);
    await goOn(alice);
    await until("the place started", () => places.length === 1);
    finishPlace(new Error("no room in her home"));
    await until("the job ended", () => !memberPlaceRunning(alice));
    expect(memberOsUserState(alice)).toEqual({
      kind: "isolated",
      osUser: { name: "isomux-alice", uid: MEMBER_UID },
      unfinished: true,
      movedIn: { home: OLD_HOME },
    });
    expect(steps).not.toContain("removeStage");
    expect(steps).not.toContain("restoreUnits");
    expect(steps.filter((s) => s === "release").length).toBe(1);
    const failed = await goOn(alice);
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ ok: false, ready: false, kept: true });
    expect(places.length).toBe(1);
    // The owner runs enable again: a new job from the start.
    const rerun = await goOn(alice);
    expect(rerun.body).toMatchObject({ ok: true, ready: false, running: true });
    await until("the second place started", () => places.length === 2);
    finishPlace();
    await until("the second job ended", () => !memberPlaceRunning(alice));
  });

  // A step that throws after the job marked her moving (here the connect)
  // ends the job as a failure: her agents are released, the moving mark goes
  // (D5: it is what lets her runner connect), and the record keeps the new
  // uid, so the root command keeps the user.
  it("a step that throws after the record ends the job as a kept failure, releases her agents and clears the moving mark", async () => {
    const alice = member("Alice");
    movedInRecord(alice);
    movedDeps(alice, {}, new Error("the share check threw"));
    const first = await goOn(alice);
    expect(first.body).toMatchObject({ ok: true, running: true });
    await until("the job ended", () => !memberPlaceRunning(alice));
    // The condition: the step that threw ran.
    expect(steps).toContain("connect");
    expect(steps.filter((s) => s === "release").length).toBe(1);
    expect(memberIsMoving(alice)).toBe(false);
    expect(memberOsUserState(alice)).toMatchObject({
      kind: "isolated",
      osUser: { name: "isomux-alice", uid: MEMBER_UID },
      movedIn: { home: OLD_HOME },
    });
    const failed = await goOn(alice);
    expect(failed.body).toMatchObject({ ok: false, ready: false, kept: true });
  });

  it("D9: disable with deleteMovedHome removes her moved home with the record and says so; plain and keepFiles alone refuse and keep both", async () => {
    const alice = member("Alice");
    movedInRecord(alice);
    movedDeps(alice);
    // keepFiles keeps files: it never deletes the home that came with the
    // move.
    for (const body of [{}, { keepFiles: true }, { deleteMovedHome: false }]) {
      const refused = await call("disable", { member: alice, ...body });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("moved_in");
      expect(steps).not.toContain("removeStage");
      expect(memberOsUserState(alice).kind).toBe("isolated");
    }
    const answer = await call("disable", {
      member: alice,
      keepFiles: true,
      deleteMovedHome: true,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      ok: true,
      kept: true,
      movedHomeRemoved: true,
    });
    expect(steps).toContain("removeStage");
    expect(memberOsUserState(alice).kind).toBe("none");
  });

  it("D9: deleteMovedHome alone is enough for a moved-in member", async () => {
    const alice = member("Alice");
    movedInRecord(alice);
    movedDeps(alice);
    const answer = await call("disable", {
      member: alice,
      deleteMovedHome: true,
    });
    expect(answer.body).toMatchObject({ ok: true, movedHomeRemoved: true });
    expect(steps).toContain("removeStage");
    expect(memberOsUserState(alice).kind).toBe("none");
  });

  it("D9: deleteMovedHome on a member who did not move refuses and changes nothing, also with keepFiles", async () => {
    const alice = member("Alice");
    recordMemberOsUser(alice, { name: "isomux-alice", uid: MEMBER_UID });
    movedDeps(alice);
    // Her record, as a scalar: hostFor builds a new not-ready host on each
    // call while her runner is not connected, so host identity says nothing.
    const record = () => {
      const state = memberOsUserState(alice);
      return state.kind === "isolated"
        ? `${state.osUser.name}:${state.osUser.uid}:${state.movedIn ? "moved" : "here"}`
        : state.kind;
    };
    const onOffice = () => hostFor(alice) === officeAgentHost();
    // The enabling condition: isolated, never on the office host.
    expect([record(), onOffice()]).toEqual([
      `isomux-alice:${MEMBER_UID}:here`,
      false,
    ]);
    for (const body of [
      { deleteMovedHome: true },
      { deleteMovedHome: true, keepFiles: true },
    ]) {
      const refused = await call("disable", { member: alice, ...body });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("not_moved_in");
      expect([record(), onOffice()]).toEqual([
        `isomux-alice:${MEMBER_UID}:here`,
        false,
      ]);
      expect(steps).not.toContain("removeStage");
    }
    // keepFiles alone still gives up her files (the case above is not a
    // refusal of every disable).
    expect(
      (await call("disable", { member: alice, keepFiles: true })).body,
    ).toEqual({ ok: true, kept: true });
    expect(memberOsUserState(alice).kind).toBe("none");
  });

  it("D5: her runner does not connect while no place runs", async () => {
    const alice = member("Alice");
    movedInRecord(alice);
    let lookups = 0;
    setMemberHostDeps({
      lookupUser: () => {
        lookups++;
        throw new Error("no such user");
      },
    });
    expect(await connectMemberHost(alice)).toBe(false);
    expect(lookups).toBe(0);
    // Not ready, and never the office user.
    expect(hostFor(alice)).not.toBe(officeAgentHost());
    // The enabling case: a member who did not move gets a connect attempt.
    recordMemberOsUser(alice, { name: "isomux-alice", uid: MEMBER_UID });
    expect(await connectMemberHost(alice)).toBe(false);
    expect(lookups).toBe(1);
  });

  it("a moved-in member's old uid does not take that uid from a member enabled here", async () => {
    const alice = member("Alice");
    const bob = member("Bob");
    // Bob came with the move; on the old box he had the uid that Alice's
    // new user has here.
    writeFileSync(
      memberOsUsersPath(),
      JSON.stringify({
        [bob]: {
          name: "isomux-bob",
          uid: MEMBER_UID,
          movedIn: { home: "/home/isomux-bob" },
        },
      }),
    );
    reloadMemberOsUsers();
    deps();
    const answer = await goOn(alice);
    expect(answer.body.error).not.toBe("os_user_taken");
    expect(answer.body).toMatchObject({ ok: true, ready: true });
  });
});

// Task e15a82e7: go-on of a person's existing OS user. The root command
// sends adopted (and rootCapable, for a user that can become root); go-on
// writes both to the record on every call, so a rerun clears what it does
// not send, and refuses rootCapable without adopted (a user the command made
// never becomes root) and any value but true, before any write or connect.
describe("go-on of an existing OS user", () => {
  const goOnWith = (memberRef: string, extra: Record<string, unknown>) =>
    call("go-on", {
      member: memberRef,
      osUser: "isomux-alice",
      uid: MEMBER_UID,
      ...extra,
    });
  const origin = (userId: string) => {
    const state = memberOsUserState(userId) as {
      adopted?: unknown;
      rootCapable?: unknown;
    };
    return { adopted: state.adopted, rootCapable: state.rootCapable };
  };

  it("records adopted, and rootCapable with it, through a reload; a made user's go-on records neither", async () => {
    const alice = member("Alice");
    const bob = member("Bob");
    deps();
    expect((await goOn(bob, "isomux-alice")).body.ready).toBe(true);
    expect(origin(bob)).toEqual({ adopted: undefined, rootCapable: undefined });
    deps();
    // Bob's record would take the user: drop it.
    rmSync(memberOsUsersPath(), { force: true });
    reloadMemberOsUsers();
    expect((await goOnWith(alice, { adopted: true })).body.ready).toBe(true);
    reloadMemberOsUsers();
    expect(origin(alice)).toEqual({ adopted: true, rootCapable: undefined });
    expect(
      (await goOnWith(alice, { adopted: true, rootCapable: true })).body.ready,
    ).toBe(true);
    reloadMemberOsUsers();
    expect(origin(alice)).toEqual({ adopted: true, rootCapable: true });
  });

  it("writes both on every call: a rerun that sends less clears the rest", async () => {
    const alice = member("Alice");
    deps();
    await goOnWith(alice, { adopted: true, rootCapable: true });
    expect(origin(alice)).toEqual({ adopted: true, rootCapable: true });
    // The user lost sudo: the rerun sends adopted only.
    expect((await goOnWith(alice, { adopted: true })).body.ready).toBe(true);
    expect(origin(alice)).toEqual({ adopted: true, rootCapable: undefined });
    expect((await goOn(alice)).body.ready).toBe(true);
    expect(origin(alice)).toEqual({
      adopted: undefined,
      rootCapable: undefined,
    });
  });

  for (const [label, extra] of [
    ["rootCapable without adopted", { rootCapable: true }],
    ["rootCapable with adopted false", { adopted: false, rootCapable: true }],
    ["adopted that is not true", { adopted: "yes" }],
    ["rootCapable that is not true", { adopted: true, rootCapable: 1 }],
  ] as const)
    it(`refuses ${label} before any write or connect`, async () => {
      const alice = member("Alice");
      deps();
      const answer = await goOnWith(alice, extra);
      expect([label, answer.status >= 400 && answer.status < 500]).toEqual([
        label,
        true,
      ]);
      expect(answer.body.ready).not.toBe(true);
      expect(memberOsUserState(alice).kind).toBe("none");
      expect(connects).toEqual([]);
      // The enabling condition: the same go-on without the bad field goes on.
      expect((await goOn(alice)).body.ready).toBe(true);
    });

  it("refuses rootCapable without adopted on the rerun of a recorded member, and keeps the record as it was", async () => {
    const alice = member("Alice");
    deps();
    await goOnWith(alice, { adopted: true });
    connects.length = 0;
    const answer = await goOnWith(alice, { rootCapable: true });
    expect(answer.status >= 400 && answer.status < 500).toBe(true);
    expect(origin(alice)).toEqual({ adopted: true, rootCapable: undefined });
    expect(connects).toEqual([]);
  });
});
