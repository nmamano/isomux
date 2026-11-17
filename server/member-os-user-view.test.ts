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
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";

import {
  clearMemberUserAttempt,
  CONTAINER_PLACEHOLDER,
  MEMBER_USER_COMMAND_PATH,
  memberUserSupport,
  type MemberUserSupportInput,
  memberOsUserView,
  memberUserCommands,
  type MemberUserSupport,
  noteMemberUserAttempt,
  PREPARED_STALE_MS,
  resetMemberUserAttempts,
} from "./member-os-user-view.ts";
import {
  memberOsUsersPath,
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
