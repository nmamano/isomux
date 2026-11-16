// The owner's view of a member's own OS user (task b94dfd25 4c-i,
// server/member-os-user-view.ts). The properties:
// - the shape: the container by its supervisor, the installer by its root
//   command, nothing elsewhere or off Linux;
// - the command holds the member id only, and only an id of the id pattern:
//   nothing else a member could set reaches a line an owner runs as root;
// - the state comes from the records (off, broken, not_ready, moving, on);
// - the attempt reads running, failed (with its message) or stopped (an
//   enable that prepared and never went on), and an owner gets no command.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";

import {
  clearMemberUserAttempt,
  MEMBER_USER_COMMAND_PATH,
  memberOsUserView,
  memberUserCommands,
  memberUserShape,
  noteMemberUserAttempt,
  PREPARED_STALE_MS,
  resetMemberUserAttempts,
} from "./member-os-user-view.ts";
import {
  memberOsUsersPath,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "./member-os-users.ts";
import { clearMemberMoving, markMemberMoving } from "./member-hosts.ts";
import { createMember, deleteUserById } from "./users.ts";
import {
  isolateMember,
  type IsolatedMember,
} from "./test-support/member-host-fixture.ts";

const ID = "0a1b2c3d";
const NOW = 1_790_000_000_000;

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

describe("the shape", () => {
  it("is the container by its supervisor, the installer by its root command, and nothing elsewhere", () => {
    const has = (path: string) => path === MEMBER_USER_COMMAND_PATH;
    const none = () => false;
    expect([
      memberUserShape({ ISOMUX_APP_SUPERVISOR: "container" }, none, "linux"),
      memberUserShape({}, has, "linux"),
      // A user-level install has no root command.
      memberUserShape({}, none, "linux"),
      memberUserShape({ ISOMUX_APP_SUPERVISOR: "container" }, has, "darwin"),
      memberUserShape({}, has, "darwin"),
    ]).toEqual(["container", "installer", null, null, null]);
  });
});

describe("the command", () => {
  // The shell words of a line; the lines hold no quotes, so a split is exact.
  const words = (line: string) => line.split(" ");

  it("runs the root-owned command with the verb and the id, on each shape", () => {
    const installer = memberUserCommands(ID, "installer")!;
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
    const container = memberUserCommands(ID, "container")!;
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
    expect(memberUserCommands(ID, null)).toBeNull();
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
      for (const shape of ["installer", "container"] as const)
        expect({ id, shape, commands: memberUserCommands(id, shape) }).toEqual({
          id,
          shape,
          commands: null,
        });
  });
});

describe("the state", () => {
  const view = (role: "member" | "owner" = "member") =>
    memberOsUserView(
      { id: ID, role },
      { gate: true, shape: "installer", now: NOW },
    );

  it("is off with no record, broken with a bad record, and not_ready while the runner is not connected", () => {
    expect(view()).toMatchObject({ state: "off", gate: true, run: null });
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
  });

  it("is on while the member's runner is connected", async () => {
    const made = createMember(`OsViewAlice${Date.now()}`, { role: "member" });
    if (!made.ok) throw new Error(made.error);
    let iso: IsolatedMember | null = null;
    try {
      iso = await isolateMember(made.user.id);
      const on = memberOsUserView(made.user, {
        gate: true,
        shape: "installer",
        now: NOW,
      });
      expect(on.state).toBe("on");
      expect(on.osUser?.uid).toBe(process.getuid!());
      markMemberMoving(made.user.id);
      expect(
        memberOsUserView(made.user, { gate: true, shape: "installer" }).state,
      ).toBe("moving");
      clearMemberMoving(made.user.id);
    } finally {
      iso?.dispose();
      deleteUserById(made.user.id);
    }
  });

  it("gives an owner no command, and passes the gate through", () => {
    expect(view("owner").commands).toBeNull();
    expect(view("member").commands).toEqual(
      memberUserCommands(ID, "installer"),
    );
    expect(
      memberOsUserView(
        { id: ID, role: "member" },
        { gate: false, shape: "installer", now: NOW },
      ).gate,
    ).toBe(false);
  });
});

describe("the attempt", () => {
  const attemptAt = (now: number) =>
    memberOsUserView(
      { id: ID, role: "member" },
      { gate: true, shape: "installer", now },
    ).attempt;

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
