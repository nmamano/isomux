// The owner's view of a member's own OS user (task b94dfd25 4c-i,
// server/member-os-user-view.ts). The properties:
// - the support verdict: off Linux, Kubernetes and Render first (each wins
//   over a container's supervisor), then the installer's container by its
//   conf, another Docker container by its supervisor, then the installer's
//   system install and its root command; a conf that does not parse is no
//   conf;
// - a Docker container's own hostname reaches the command only when it is
//   Docker's short id, else the placeholder does;
// - the command holds the member id only, and only an id of the id pattern:
//   nothing else a member could set reaches a line an owner runs as root;
// - the state comes from the records (off, broken, not_ready, moving, on); a
//   record that says the files move keeps the member not ready (unfinished),
//   connected or not, and their host starts nothing;
// - the attempt reads running, failed (with its message) or stopped (an
//   enable that prepared and never went on), and an owner gets no command;
// - the office's OS user (task 83ebaa3c) comes with every state and every
//   support, is the server's own by default, and is left out when unknown.
// - the new user's default name (task 3b5234dc) is the member's own name
//   fitted to the user-name pattern, with no prefix; when another user or
//   group holds it, the first free of <name>2, <name>3, ... (at most 32
//   characters); with no names read, the plain name.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";

import {
  clearMemberUserAttempt,
  CONTAINER_PLACEHOLDER,
  freeOsUserName,
  MEMBER_USER_COMMAND_PATH,
  memberUserSupport,
  type MemberUserSupportInput,
  MEMBER_USER_CANDIDATES_MAX,
  memberOsUserName,
  memberOsUserView,
  memberUserCandidates,
  type MemberUserCandidatesInput,
  memberUserCommands,
  type MemberUserSupport,
  noteMemberUserAttempt,
  osUserNamesTaken,
  PREPARED_STALE_MS,
  resetMemberUserAttempts,
} from "./member-os-user-view.ts";
import {
  memberOsUsersPath,
  OS_USER_NAME_PATTERN,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "./member-os-users.ts";
import {
  clearMemberMoving,
  connectMemberHost,
  hostFor,
  markMemberMoving,
  memberAppRunner,
  onMemberConnected,
  resetMemberHosts,
} from "./member-hosts.ts";
import { createMember, deleteUserById } from "./users.ts";
import type { UpdateConfRead } from "./update-conf.ts";
import {
  isolateMember,
  type IsolatedMember,
} from "./test-support/member-host-fixture.ts";

const ID = "0a1b2c3d";
const NOW = 1_790_000_000_000;
const INSTALLER: MemberUserSupport = { ok: true, shape: "installer" };
const CONTAINER: MemberUserSupport = { ok: true, shape: "container" };
const UNSUPPORTED: MemberUserSupport = {
  ok: false,
  reason: "no_system_install",
};

beforeEach(() => {
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
  resetMemberUserAttempts();
});
afterEach(() => {
  rmSync(memberOsUsersPath(), { force: true });
  reloadMemberOsUsers();
  resetMemberUserAttempts();
  clearMemberMoving(ID);
});

describe("the support verdict", () => {
  const SHORT_ID = "0123456789ab";
  // An installer box with the root command: every input that the verdict
  // reads, so each case changes only what it names.
  const input = (
    over: Partial<MemberUserSupportInput> = {},
  ): MemberUserSupportInput => ({
    env: {},
    exists: (path) => path === MEMBER_USER_COMMAND_PATH,
    platform: "linux",
    hostname: SHORT_ID,
    conf: {
      state: "parsed",
      values: { SERVICE_KIND: "system", DEPLOYMENT_KIND: "git" },
    },
    ...over,
  });
  const verdict = (over: Partial<MemberUserSupportInput> = {}) =>
    memberUserSupport(input(over));
  const reason = (over: Partial<MemberUserSupportInput>) => {
    const v = verdict(over);
    return v.ok ? `ok:${v.shape}` : v.reason;
  };
  const SUPERVISED = { ISOMUX_APP_SUPERVISOR: "container" };
  const COMPOSE_CONF = {
    state: "parsed" as const,
    values: { DEPLOYMENT_KIND: "container", SERVICE_KIND: "system" },
  };

  it("is the installer on a system install with the root command, and says why not without either", () => {
    expect(verdict()).toEqual({ ok: true, shape: "installer" });
    expect(reason({ exists: () => false })).toBe("no_command");
    const confs: UpdateConfRead[] = [
      { state: "absent" },
      { state: "invalid" },
      { state: "parsed", values: { SERVICE_KIND: "user" } },
      { state: "parsed", values: { DEPLOYMENT_KIND: "git" } },
    ];
    for (const conf of confs)
      expect({ conf, reason: reason({ conf }) }).toEqual({
        conf,
        reason: "no_system_install",
      });
  });

  it("is the installer's container by its conf, and another Docker container without it", () => {
    expect(verdict({ env: SUPERVISED, conf: COMPOSE_CONF })).toEqual({
      ok: true,
      shape: "container",
    });
    for (const conf of [
      { state: "absent" as const },
      { state: "invalid" as const },
    ])
      expect({ conf, v: verdict({ env: SUPERVISED, conf }) }).toEqual({
        conf,
        v: { ok: true, shape: "docker", container: SHORT_ID },
      });
    // The conf alone is not a container: the supervisor is.
    expect(reason({ conf: COMPOSE_CONF, exists: () => false })).toBe(
      "no_command",
    );
  });

  it("refuses off Linux, on Kubernetes and on Render, before a container's supervisor counts", () => {
    const container = { env: SUPERVISED, conf: COMPOSE_CONF };
    expect(reason({ ...container, platform: "darwin" })).toBe("not_linux");
    expect(reason({ platform: "win32" })).toBe("not_linux");
    const k8s = { ...SUPERVISED, KUBERNETES_SERVICE_HOST: "10.0.0.1" };
    expect(reason({ ...container, env: k8s })).toBe("kubernetes");
    expect(reason({ env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" } })).toBe(
      "kubernetes",
    );
    expect(
      reason({ ...container, env: { ...SUPERVISED, RENDER: "true" } }),
    ).toBe("render");
    // Off Linux wins over Kubernetes.
    expect(reason({ ...container, env: k8s, platform: "darwin" })).toBe(
      "not_linux",
    );
    // An empty value is no Kubernetes; Render only by its own value.
    expect(
      reason({
        ...container,
        env: { ...SUPERVISED, KUBERNETES_SERVICE_HOST: "" },
      }),
    ).toBe("ok:container");
    expect(
      reason({ ...container, env: { ...SUPERVISED, RENDER: "false" } }),
    ).toBe("ok:container");
  });

  it("puts a Docker container's hostname in the command only when it is Docker's short id", () => {
    const docker = (hostname: string) =>
      memberUserCommands(
        ID,
        verdict({ env: SUPERVISED, hostname, conf: { state: "absent" } }),
      )!;
    for (const verb of ["enable", "disable"] as const)
      expect(docker(SHORT_ID)[verb].split(" ")).toEqual([
        "sudo",
        "docker",
        "exec",
        "-u",
        "0",
        SHORT_ID,
        MEMBER_USER_COMMAND_PATH,
        verb,
        ID,
      ]);
    for (const hostname of [
      "my-office",
      "0123456789AB",
      "0123456789abc",
      "0123456789a",
      "$(id)6789ab",
      "0123456789ab;id",
      "",
    ]) {
      const line = docker(hostname).enable;
      expect({ hostname, words: line.split(" ").slice(5, 7) }).toEqual({
        hostname,
        words: [CONTAINER_PLACEHOLDER, MEMBER_USER_COMMAND_PATH],
      });
      if (hostname)
        expect({ hostname, in: line.includes(hostname) }).toEqual({
          hostname,
          in: false,
        });
    }
  });

  it("asks the owner for the container's name only when the command holds the placeholder", () => {
    const view = (
      support: MemberUserSupport,
      role: "member" | "owner" = "member",
    ) => memberOsUserView({ id: ID, role }, { support, now: NOW }).commandHint;
    expect(view({ ok: true, shape: "docker", container: null })).toBe(
      "container_name",
    );
    expect(
      view({ ok: true, shape: "docker", container: SHORT_ID }),
    ).toBeUndefined();
    expect(view(INSTALLER)).toBeUndefined();
    expect(view(CONTAINER)).toBeUndefined();
    // No command, no hint.
    expect(
      view({ ok: true, shape: "docker", container: null }, "owner"),
    ).toBeUndefined();
  });
});

describe("the command", () => {
  // The shell words of a line; the lines hold no quotes, so a split is exact.
  const words = (line: string) => line.split(" ");

  it("runs the root-owned command with the verb and the id, on each shape", () => {
    const installer = memberUserCommands(ID, INSTALLER)!;
    expect(words(installer.enable)).toEqual([
      "sudo",
      MEMBER_USER_COMMAND_PATH,
      "enable",
      ID,
    ]);
    expect(words(installer.disable)).toEqual([
      "sudo",
      MEMBER_USER_COMMAND_PATH,
      "disable",
      ID,
    ]);
    const container = memberUserCommands(ID, CONTAINER)!;
    for (const verb of ["enable", "disable"] as const) {
      const line = words(container[verb]);
      // The compose folder of the installer, then root in the office
      // container, then the same command.
      expect(line.slice(0, 3)).toEqual(["cd", "/opt/isomux-container", "&&"]);
      expect(line.slice(-6)).toEqual([
        "-u",
        "0",
        "office",
        MEMBER_USER_COMMAND_PATH,
        verb,
        ID,
      ]);
    }
    expect(memberUserCommands(ID, UNSUPPORTED)).toBeNull();
  });

  it("takes only an id of the id pattern: anything else gives no command", () => {
    for (const id of [
      "",
      "0A1B2C3D",
      "0a1b2c3",
      "0a1b2c3d4",
      "0a1b2c3d; rm -rf /",
      "0a1b2c3d\n",
      " 0a1b2c3d",
      "$(id)abcd",
      "../0a1b2c",
    ])
      for (const shape of [INSTALLER, CONTAINER])
        expect({ id, shape, commands: memberUserCommands(id, shape) }).toEqual({
          id,
          shape,
          commands: null,
        });
  });
});

describe("the state", () => {
  const view = (role: "member" | "owner" = "member") =>
    memberOsUserView({ id: ID, role }, { support: INSTALLER, now: NOW });

  it("is off with no record, broken with a bad record, and not_ready while the runner is not connected", () => {
    expect(view()).toMatchObject({
      state: "off",
      support: { ok: true },
      run: null,
    });
    expect(view().osUser).toBeUndefined();
    writeFileSync(memberOsUsersPath(), "{ not json");
    reloadMemberOsUsers();
    const broken = view();
    expect(broken.state).toBe("broken");
    expect(typeof broken.reason).toBe("string");
    rmSync(memberOsUsersPath(), { force: true });
    reloadMemberOsUsers();
    recordMemberOsUser(ID, { name: "isomux-alice", uid: 2001 });
    expect(view()).toMatchObject({
      state: "not_ready",
      osUser: { name: "isomux-alice", uid: 2001 },
    });
    markMemberMoving(ID);
    expect(view().state).toBe("moving");
    clearMemberMoving(ID);
    // A move that a stop cut: not ready, and says so, also after a reload
    // (a restart); during the rerun's move it is moving.
    recordMemberOsUser(
      ID,
      { name: "isomux-alice", uid: 2001 },
      { moving: true },
    );
    reloadMemberOsUsers();
    expect(view()).toMatchObject({ state: "not_ready", unfinished: true });
    markMemberMoving(ID);
    expect(view().state).toBe("moving");
    expect(view().unfinished).toBeUndefined();
    clearMemberMoving(ID);
    recordMemberOsUser(ID, { name: "isomux-alice", uid: 2001 });
    expect(view().unfinished).toBeUndefined();
  });

  it("is on while the member's runner is connected", async () => {
    const made = createMember(`OsViewAlice${Date.now()}`, { role: "member" });
    if (!made.ok) throw new Error(made.error);
    let iso: IsolatedMember | null = null;
    try {
      iso = await isolateMember(made.user.id);
      const on = memberOsUserView(made.user, {
        support: INSTALLER,
        now: NOW,
      });
      expect(on.state).toBe("on");
      expect(on.osUser?.uid).toBe(process.getuid!());
      markMemberMoving(made.user.id);
      expect(memberOsUserView(made.user, { support: INSTALLER }).state).toBe(
        "moving",
      );
      clearMemberMoving(made.user.id);
      // The enabling condition of the flip below: connected, the runner's
      // host and an app runner.
      expect(hostFor(made.user.id).home()).toBe(iso.home);
      expect(memberAppRunner(made.user.id)).not.toBeNull();
      // Connected, but the record says the files move: not ready, a host
      // that starts nothing, no app runner.
      const osUser = on.osUser!;
      recordMemberOsUser(made.user.id, osUser, { moving: true });
      expect(
        memberOsUserView(made.user, { support: INSTALLER, now: NOW }),
      ).toMatchObject({ state: "not_ready", unfinished: true });
      expect(hostFor(made.user.id).home()).not.toBe(iso.home);
      expect(memberAppRunner(made.user.id)).toBeNull();
      recordMemberOsUser(made.user.id, osUser);
      expect(
        memberOsUserView(made.user, { support: INSTALLER, now: NOW }).state,
      ).toBe("on");
      expect(hostFor(made.user.id).home()).toBe(iso.home);
      // A connect (a boot) with the mark runs none of the office's connect
      // work for the member (their skills, their apps); one without it does.
      const heard: string[] = [];
      const stop = onMemberConnected((id) => void heard.push(id));
      try {
        for (const moving of [true, false]) {
          resetMemberHosts();
          recordMemberOsUser(made.user.id, osUser, { moving });
          expect(await connectMemberHost(made.user.id)).toBe(true);
          expect({ moving, heard: heard.length }).toEqual({
            moving,
            heard: moving ? 0 : 1,
          });
        }
      } finally {
        stop();
      }
    } finally {
      iso?.dispose();
      deleteUserById(made.user.id);
    }
  });

  // Slice 5c-3 (task 78733adf): a member who came with an office move is
  // not ready until the enable command places her home, also while its job
  // runs and her runner is connected for it. Her disable command deletes
  // that home (--delete-moved-home): the office refuses a plain disable of
  // her, and --keep-files does not delete it.
  it("is not ready and moved in while the record says movedIn, connected or not, during the place too; the disable command then deletes the moved home", async () => {
    const plain = memberUserCommands(ID, INSTALLER)!;
    recordMemberOsUser(
      ID,
      { name: "isomux-alice", uid: 2001 },
      { movedIn: { home: "/home/isomux-alice" } },
    );
    const moved = view();
    expect(moved).toMatchObject({ state: "not_ready", movedIn: true });
    expect(moved.commands?.enable).toBe(plain.enable);
    expect(moved.commands?.disable).toBe(
      `${plain.disable} --delete-moved-home`,
    );
    expect(moved.commands?.disable.includes("--keep-files")).toBe(false);
    // Her place job marks her moving: still not ready, still moved in.
    markMemberMoving(ID);
    expect(view()).toMatchObject({ state: "not_ready", movedIn: true });
    clearMemberMoving(ID);
    // The enabling case: without movedIn, the plain commands and no flag.
    recordMemberOsUser(ID, { name: "isomux-alice", uid: 2001 });
    const after = view();
    expect(after.movedIn).toBeUndefined();
    expect(after.commands?.disable).toBe(plain.disable);

    // Connected for her place job: not on.
    const made = createMember(`OsViewMoved${Date.now()}`, { role: "member" });
    if (!made.ok) throw new Error(made.error);
    let iso: IsolatedMember | null = null;
    try {
      iso = await isolateMember(made.user.id);
      const on = memberOsUserView(made.user, { support: INSTALLER, now: NOW });
      // The enabling condition: connected reads on.
      expect(on.state).toBe("on");
      recordMemberOsUser(made.user.id, on.osUser!, {
        movedIn: { home: iso.home },
      });
      expect(
        memberOsUserView(made.user, { support: INSTALLER, now: NOW }),
      ).toMatchObject({ state: "not_ready", movedIn: true });
    } finally {
      iso?.dispose();
      deleteUserById(made.user.id);
    }
  });

  it("carries the office's OS user in every state and support, the server's own by default, and none when unknown", () => {
    const states: string[] = [];
    // Each state the records give without a runner, then the check.
    const check = () => {
      for (const support of [INSTALLER, UNSUPPORTED]) {
        const given = memberOsUserView(
          { id: ID, role: "member" },
          { support, now: NOW, officeOsUser: "svc-office" },
        );
        states.push(given.state);
        expect({
          state: given.state,
          support: support.ok,
          officeOsUser: given.officeOsUser,
        }).toEqual({
          state: given.state,
          support: support.ok,
          officeOsUser: "svc-office",
        });
        const unknown = memberOsUserView(
          { id: ID, role: "member" },
          { support, now: NOW, officeOsUser: null },
        );
        // The enabling condition: the same state with null.
        expect(unknown.state).toBe(given.state);
        expect({
          state: unknown.state,
          has: "officeOsUser" in unknown,
        }).toEqual({ state: given.state, has: false });
        expect(
          memberOsUserView({ id: ID, role: "member" }, { support, now: NOW })
            .officeOsUser,
        ).toBe(userInfo().username);
      }
    };
    check();
    writeFileSync(memberOsUsersPath(), "{ not json");
    reloadMemberOsUsers();
    check();
    rmSync(memberOsUsersPath(), { force: true });
    reloadMemberOsUsers();
    recordMemberOsUser(ID, { name: "isomux-alice", uid: 2001 });
    check();
    markMemberMoving(ID);
    check();
    clearMemberMoving(ID);
    expect([...new Set(states)]).toEqual([
      "off",
      "broken",
      "not_ready",
      "moving",
    ]);
  });

  it("gives an owner no command, and passes the gate through", () => {
    expect(view("owner").commands).toBeNull();
    expect(view("member").commands).toEqual(memberUserCommands(ID, INSTALLER));
    expect(
      memberOsUserView(
        { id: ID, role: "member" },
        { support: UNSUPPORTED, now: NOW },
      ).support,
    ).toEqual({ ok: false, reason: "no_system_install" });
  });
});

describe("the attempt", () => {
  const attemptAt = (now: number) =>
    memberOsUserView({ id: ID, role: "member" }, { support: INSTALLER, now })
      .attempt;

  it("reads running, failed with its message, and none once cleared", () => {
    expect(attemptAt(NOW)).toBeUndefined();
    noteMemberUserAttempt(ID, "enable", "running", undefined, NOW);
    expect(attemptAt(NOW)).toEqual({
      action: "enable",
      status: "running",
      at: NOW,
    });
    noteMemberUserAttempt(ID, "disable", "failed", "the runner is gone", NOW);
    expect(attemptAt(NOW)).toEqual({
      action: "disable",
      status: "failed",
      at: NOW,
      message: "the runner is gone",
    });
    clearMemberUserAttempt(ID);
    expect(attemptAt(NOW)).toBeUndefined();
  });

  it("reads a prepared enable as running, and as stopped once it is older than PREPARED_STALE_MS", () => {
    noteMemberUserAttempt(ID, "enable", "prepared", undefined, NOW);
    expect(attemptAt(NOW + PREPARED_STALE_MS)?.status).toBe("running");
    expect(attemptAt(NOW + PREPARED_STALE_MS + 1)?.status).toBe("stopped");
    // A running go-on is never stale: the move may take hours.
    noteMemberUserAttempt(ID, "enable", "running", undefined, NOW);
    expect(attemptAt(NOW + 3 * 60 * 60_000)?.status).toBe("running");
  });

  it("is kept per member id", () => {
    noteMemberUserAttempt("ffffffff", "enable", "failed", "other", NOW);
    expect(attemptAt(NOW)).toBeUndefined();
    resetMemberUserAttempts();
  });
});

// Task e15a82e7: the existing OS users an owner can pick for a member, and
// what the page needs to pick one. The properties:
// - a candidate is a login user: a passwd entry with a name of the root
//   command's pattern, a uid in UID_MIN..UID_MAX of login.defs (defaults
//   1000..60000, both ends in), a login shell; never the office's user, a
//   user a member runs as or a user the root command made; each name once,
//   sorted by name, at most MEMBER_USER_CANDIDATES_MAX;
// - the view carries the candidates only while off, on the installer's
//   install; the new user's default name while off; adopted and rootCapable
//   from the record.
describe("the candidates", () => {
  const line = (name: string, uid: number, shell = "/bin/bash") =>
    `${name}:x:${uid}:${uid}:${name}:/home/${name}:${shell}`;
  const input = (
    lines: string[],
    over: Partial<MemberUserCandidatesInput> = {},
  ): MemberUserCandidatesInput => ({
    passwd: lines.join("\n") + "\n",
    loginDefs: "",
    officeOsUser: "isomux",
    taken: [],
    made: [],
    ...over,
  });
  const names = (i: MemberUserCandidatesInput) =>
    memberUserCandidates(i).map((c) => c.name);

  it("are login users with their uid, sorted by name", () => {
    expect(
      memberUserCandidates(
        input([line("carol", 1500, "/bin/zsh"), line("bob", 1001)]),
      ),
    ).toEqual([
      { name: "bob", uid: 1001 },
      { name: "carol", uid: 1500 },
    ]);
  });

  it("leave out system users, users out of the uid range and users with no login shell, and keep both ends of the range", () => {
    const lines = [
      line("root", 0),
      line("daemon", 1, "/usr/sbin/nologin"),
      line("svc", 999),
      line("low", 1000),
      line("high", 60000),
      line("over", 60001),
      line("nobody", 65534, "/usr/sbin/nologin"),
      line("nolog1", 1100, "/usr/sbin/nologin"),
      line("nolog2", 1101, "/sbin/nologin"),
      line("false1", 1102, "/bin/false"),
      line("false2", 1103, "/usr/bin/false"),
      line("dana", 1200),
    ];
    expect(names(input(lines))).toEqual(["dana", "high", "low"]);
  });

  it("take the uid range from login.defs, its comments and spacing aside, and the defaults for a value that does not parse", () => {
    const lines = [line("a1", 600), line("a2", 1500), line("a3", 2500)];
    expect(
      names(
        input(lines, {
          loginDefs:
            "# UID_MIN 3000\nUID_MIN\t\t\t 500\n  UID_MAX   2000\nSYS_UID_MAX 499\n",
        }),
      ),
    ).toEqual(["a1", "a2"]);
    expect(
      names(input(lines, { loginDefs: "UID_MIN lots\nUID_MAX -5\n" })),
    ).toEqual(["a2", "a3"]);
  });

  it("leave out the office's user, a user a member runs as and a user the root command made", () => {
    const lines = [
      line("isomux", 1001),
      line("isomux-mia", 1002),
      line("isomux-old", 1003),
      line("erin", 1004),
    ];
    expect(
      names(input(lines, { taken: ["isomux-mia"], made: ["isomux-old"] })),
    ).toEqual(["erin"]);
    // The office's user is left out by name, whatever its uid.
    expect(names(input(lines, { officeOsUser: null }))).toContain("isomux");
  });

  it("leave out a name a root command line cannot hold, and a line that does not parse", () => {
    const lines = [
      line("Upper", 1001),
      line("dot.name", 1002),
      line("-dash", 1003),
      line("x".repeat(33), 1004),
      "bad:x:notanumber:1:::/bin/bash",
      "short:x:1005",
      "",
      line("fine", 1006),
    ];
    expect(names(input(lines))).toEqual(["fine"]);
  });

  it("name each user once (a local and a directory entry)", () => {
    expect(
      memberUserCandidates(input([line("gus", 1001), line("gus", 1001)])),
    ).toEqual([{ name: "gus", uid: 1001 }]);
  });

  it(`are at most MEMBER_USER_CANDIDATES_MAX, the first ones by name`, () => {
    const lines = Array.from(
      { length: MEMBER_USER_CANDIDATES_MAX + 20 },
      (_, n) => line(`u${String(n).padStart(4, "0")}`, 1001 + n),
    ).reverse();
    const got = names(input(lines));
    expect(got.length).toBe(MEMBER_USER_CANDIDATES_MAX);
    expect(got[0]).toBe("u0000");
    expect(got.at(-1)).toBe(
      `u${String(MEMBER_USER_CANDIDATES_MAX - 1).padStart(4, "0")}`,
    );
  });
});

describe("the view's fields for an existing OS user", () => {
  const CANDIDATES = [
    { name: "bob", uid: 1001 },
    { name: "carol", uid: 1500 },
  ];
  // The view of a member named "Mia Lopez", with the candidates the route
  // read (a variable: the stub's opts type may not name them yet).
  const viewOf = (
    support: MemberUserSupport,
    candidates: { name: string; uid: number }[] | null = CANDIDATES,
  ) => {
    const user = { id: ID, role: "member" as const, name: "Mia Lopez" };
    const opts = { support, now: NOW, candidates };
    return memberOsUserView(user, opts);
  };

  it("carries the candidates only while off on the installer's install, and the new user's default name while off", () => {
    expect(viewOf(INSTALLER)).toMatchObject({
      state: "off",
      candidates: CANDIDATES,
      newUserName: "mia-lopez",
    });
    // An empty list is a list (an LDAP box lists no directory users).
    expect(viewOf(INSTALLER, []).candidates).toEqual([]);
    // No list read: none on the wire.
    expect(viewOf(INSTALLER, null).candidates).toBeUndefined();
    for (const support of [
      CONTAINER,
      { ok: true, shape: "docker" } as MemberUserSupport,
    ]) {
      const v = viewOf(support);
      expect([support, v.candidates, v.newUserName]).toEqual([
        support,
        undefined,
        "mia-lopez",
      ]);
    }
    const unsupported = viewOf(UNSUPPORTED);
    expect([unsupported.candidates, unsupported.newUserName]).toEqual([
      undefined,
      undefined,
    ]);
    recordMemberOsUser(ID, { name: "isomux-mia", uid: 2001 });
    const on = viewOf(INSTALLER);
    expect([on.state, on.candidates, on.newUserName]).toEqual([
      "not_ready",
      undefined,
      undefined,
    ]);
  });

  it("says adopted and rootCapable as the record does, also after a reload, and neither for a made user", () => {
    recordMemberOsUser(ID, { name: "isomux-mia", uid: 2001 });
    const made = viewOf(INSTALLER);
    expect([made.adopted, made.rootCapable]).toEqual([undefined, undefined]);
    recordMemberOsUser(ID, { name: "bob", uid: 1001 }, { adopted: true });
    reloadMemberOsUsers();
    const adopted = viewOf(INSTALLER);
    expect([
      adopted.osUser?.name,
      adopted.adopted,
      adopted.rootCapable,
    ]).toEqual(["bob", true, undefined]);
    recordMemberOsUser(
      ID,
      { name: "bob", uid: 1001 },
      { adopted: true, rootCapable: true },
    );
    reloadMemberOsUsers();
    const capable = viewOf(INSTALLER);
    expect([capable.adopted, capable.rootCapable]).toEqual([true, true]);
  });

  it("never says rootCapable without adopted, whatever the file holds", () => {
    writeFileSync(
      memberOsUsersPath(),
      JSON.stringify({ [ID]: { name: "bob", uid: 1001, rootCapable: true } }),
    );
    reloadMemberOsUsers();
    const v = viewOf(INSTALLER);
    // The enabling condition: the entry was read (as a user, or as broken).
    expect(v.state).not.toBe("off");
    expect(v.rootCapable).toBeUndefined();
  });
});

// Task 3b5234dc: the default OS user name is the member's name, not
// isomux-<name>.
describe("the default OS user name", () => {
  it("is the member's name in lowercase, with marks dropped and other runs as one dash", () => {
    const cases: [string, string][] = [
      ["Manel", "manel"],
      ["Manél", "manel"],
      ["ÉMILE", "emile"],
      ["Ödön Smith", "odon-smith"],
      ["Mia Lopez", "mia-lopez"],
      ["Boss Big O Speedrun", "boss-big-o-speedrun"],
      ["Ma.nel", "ma-nel"],
      ["  --Bob--  ", "bob"],
      // "_" is in the pattern: it stays.
      ["mia_lopez", "mia_lopez"],
      ["café_bar 2", "cafe_bar-2"],
    ];
    expect(cases.map(([name]) => [name, memberOsUserName(name)])).toEqual(
      cases,
    );
  });

  it("puts member- before a digit, and is member when nothing of the name is left", () => {
    expect(memberOsUserName("42")).toBe("member-42");
    expect(memberOsUserName("7 Up")).toBe("member-7-up");
    for (const name of ["", "李雷", "!!!", "---"])
      expect([name, memberOsUserName(name)]).toEqual([name, "member"]);
  });

  it("is cut to 32 characters with no dash at the end", () => {
    expect(memberOsUserName("a".repeat(80))).toBe("a".repeat(32));
    // The cut ends on the dash: the dash goes.
    expect(memberOsUserName(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
    const digits = memberOsUserName("9".repeat(40));
    expect(digits).toBe(`member-${"9".repeat(25)}`);
  });

  it("always matches the root command's pattern", () => {
    for (const name of [
      "Alice",
      "Ödön Smith",
      "  --Bob--  ",
      "李雷",
      "a".repeat(80),
      "x-".repeat(30),
      "9".repeat(40),
      `${"9".repeat(30)}-x`,
      "_x",
      "-_-",
      "Ⅻ ﬁve",
    ]) {
      const got = memberOsUserName(name);
      expect([name, got, OS_USER_NAME_PATTERN.test(got)]).toEqual([
        name,
        got,
        true,
      ]);
      expect([name, got.endsWith("-")]).toEqual([name, false]);
    }
  });
});

describe("the first free OS user name", () => {
  const taken = (...names: string[]) => new Set(names);

  it("is the name when it is free, and when no names were read", () => {
    expect(freeOsUserName("manel", taken())).toBe("manel");
    expect(freeOsUserName("manel", taken("manel2", "bob"))).toBe("manel");
    expect(freeOsUserName("manel", null)).toBe("manel");
  });

  it("is the first free of <name>2, <name>3, ... when the name is taken", () => {
    expect(freeOsUserName("manel", taken("manel"))).toBe("manel2");
    expect(freeOsUserName("manel", taken("manel", "manel2"))).toBe("manel3");
    // A gap is used.
    expect(freeOsUserName("manel", taken("manel", "manel3"))).toBe("manel2");
    const nine = ["manel", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `manel${n}`)];
    expect(freeOsUserName("manel", taken(...nine))).toBe("manel10");
  });

  it("cuts the name so that the name and its number fit 32 characters", () => {
    const long = "a".repeat(32);
    expect(freeOsUserName(long, taken(long))).toBe(`${"a".repeat(31)}2`);
    const nine = [
      long,
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${"a".repeat(31)}${n}`),
    ];
    expect(freeOsUserName(long, taken(...nine))).toBe(`${"a".repeat(30)}10`);
    for (const got of [
      freeOsUserName(long, taken(long)),
      freeOsUserName(long, taken(...nine)),
    ])
      expect([got, OS_USER_NAME_PATTERN.test(got)]).toEqual([got, true]);
  });
});

describe("the new user's default name in the view", () => {
  const viewOf = (
    support: MemberUserSupport,
    osUserNames: string[] | null | undefined,
  ) => {
    const user = { id: ID, role: "member" as const, name: "Mia Lopez" };
    const opts = {
      support,
      now: NOW,
      candidates: [{ name: "mia-lopez", uid: 1001 }],
      ...(osUserNames === undefined ? {} : { osUserNames }),
    };
    return memberOsUserView(user, opts);
  };

  it("is the member's name while no user or group holds it, or no names were read", () => {
    for (const names of [undefined, null, [], ["bob", "mia-lopez2"]])
      expect([names, viewOf(INSTALLER, names).newUserName]).toEqual([
        names,
        "mia-lopez",
      ]);
  });

  it("is the next free name while the name is taken, on every shape", () => {
    for (const support of [
      INSTALLER,
      CONTAINER,
      { ok: true, shape: "docker" } as MemberUserSupport,
    ]) {
      expect([
        support,
        viewOf(support, ["mia-lopez"]).newUserName,
        viewOf(support, ["mia-lopez", "mia-lopez2"]).newUserName,
      ]).toEqual([support, "mia-lopez2", "mia-lopez3"]);
    }
    // A person's login user of that name stays a candidate to pick.
    expect(viewOf(INSTALLER, ["mia-lopez"]).candidates).toEqual([
      { name: "mia-lopez", uid: 1001 },
    ]);
  });
});

describe("the names a new user cannot take", () => {
  const PASSWD = [
    "root:x:0:0:root:/root:/bin/bash",
    "manel:x:1001:1001::/home/manel:/bin/bash",
    "isomux-old:x:1002:1002::/home/isomux-old:/bin/bash",
    "",
  ].join("\n");
  const GROUP = ["root:x:0:", "manel:x:1001:", "admin:x:110:", ""].join("\n");
  const taken = (over: Partial<Parameters<typeof osUserNamesTaken>[0]> = {}) =>
    [
      ...osUserNamesTaken({
        passwd: PASSWD,
        group: GROUP,
        recorded: [],
        made: [],
        ...over,
      }),
    ].sort();

  it("are every passwd name and every group name, also a group with no user of that name", () => {
    expect(taken()).toEqual(["admin", "isomux-old", "manel", "root"]);
    // The enabling condition of the group case: no passwd line names admin.
    expect(PASSWD.includes("admin")).toBe(false);
  });

  it("hold the names members run as, also one with no passwd line here", () => {
    expect(taken({ recorded: ["mia"] })).toContain("mia");
  });

  it("leave out a user the root command made, unless a member runs as it", () => {
    // A user that a plain disable kept (locked, its mark kept): the root
    // command resumes it for the same member, so it is offered.
    expect(taken({ made: ["isomux-old"] })).not.toContain("isomux-old");
    // A member runs as it: taken, mark or not.
    expect(taken({ recorded: ["isomux-old"], made: ["isomux-old"] })).toContain(
      "isomux-old",
    );
  });

  it("skip a line with no name or no field separator", () => {
    expect(
      taken({
        passwd: `${PASSWD}garbage\n:x:5:5::/:/bin/sh\n`,
        group: `${GROUP}\nalso-garbage`,
      }),
    ).toEqual(["admin", "isomux-old", "manel", "root"]);
  });
});
