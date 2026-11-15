// The root command isomux-member-user (deploy/isomux-member-user.sh,
// internal-docs/member-os-user-design.md 2.2-2.3; slice 1b-ii-a of task
// b94dfd25), run as a test user with every external command a PATH shim that
// logs its argv. The office is a curl shim that answers each admin.sock verb
// from a table. The properties: an owner, an isolated member and an existing
// OS user are refused before any change; a failure at any step after the
// first change undoes every change made so far, whatever the failing step
// (a refusal, a crash of the office, a failed start of the unit); disable
// deletes only a user that this command made, and asks the office before it
// stops anything; the command is installed root-owned by install.sh with the
// unit it starts.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const COMMAND = join(REPO, "deploy", "isomux-member-user.sh");
const UNIT_FILE = join(REPO, "deploy", "isomux-member-runner@.service");
const USER_ID = "u-0123456789ab";
const OS_USER = "isomux-alice";
const UNIT = `isomux-member-runner@${OS_USER}.service`;

let root: string;

// One shim per external command. Each logs "name argv..." to $T/log, and
// fails when $T/fail/<name> exists (its content, when there is one, must
// appear in the argv).
const SHIMS: Record<string, string> = {
  id: `
if [[ $# == 1 && $1 == -u ]]; then [[ -e $T/not-root ]] && echo 1000 || echo 0; exit 0; fi
case "$1 $2" in
  "-u office") echo 1000 ;;
  "-u $OS_USER") [[ -e $T/users/$OS_USER ]] && echo 2001 || exit 1 ;;
  "-g $OS_USER") echo 3001 ;;
  "-Gn $OS_USER") cat "$T/groups" 2>/dev/null || echo "$OS_USER" ;;
  *) exit 1 ;;
esac`,
  getent: `
[[ $1 == passwd ]] || exit 2
[[ -e $T/users/$2 ]] || exit 2
echo "$2:x:2001:3001::$T/home/$2:/bin/bash"`,
  useradd: `
name=\${@: -1}
mkdir -p "$T/users" "$T/home/$name"; touch "$T/users/$name"`,
  userdel: `
name=\${@: -1}
rm -rf "$T/users/$name" "$T/home/$name"`,
  usermod: `:`,
  install: `
# install -d [-o x] [-g y] [-m mode] path: a folder, the owner ignored.
mode=755
while [[ $# -gt 1 ]]; do case $1 in -m) mode=$2; shift 2 ;; -o|-g) shift 2 ;; -d) shift ;; *) shift ;; esac; done
mkdir -p "$1" && chmod "$mode" "$1"`,
  stat: `
# The share root is root's (a test user cannot make that).
path=\${@: -1}
if [[ $path == "$SHARE_ROOT" ]]; then printf '0 %s\\n' "$(command -p stat -c %a "$path")"; else command -p stat "$@"; fi`,
  loginctl: `:`,
  systemctl: `:`,
  pkill: `:`,
  pgrep: `exit 1`,
  crontab: `:`,
  atq: `:`,
  atrm: `:`,
  sudo: `echo "User $OS_USER is not allowed to run sudo on box."`,
  groupadd: `:`,
  groupdel: `:`,
  // The container's helper (python3 -I <helper> <verb> ...): next-id prints
  // $T/next-id, or 1005.
  python3: `
[[ $3 == next-id ]] && { cat "$T/next-id" 2>/dev/null || echo 1005; }
exit 0`,
  // The office: the answer to each verb is $T/answers/<verb> (body, then a
  // line with the status); a verb with no file answers 500.
  curl: `
url=\${@: -1}; verb=\${url##*/}
body=; prev=
for a in "$@"; do [[ $prev == --data ]] && body=$a; prev=$a; done
printf '%s\\n' "$body" > "$T/sent-$verb"
f=$T/answers/$verb
[[ -e $f ]] || { echo "curl: (7) connection refused" >&2; exit 7; }
cat "$f"`,
};

function answer(verb: string, status: number, body: object): void {
  mkdirSync(join(root, "answers"), { recursive: true });
  writeFileSync(
    join(root, "answers", verb),
    `${JSON.stringify(body)}\n${status}`,
  );
}

function fail(name: string, match = ""): void {
  mkdirSync(join(root, "fail"), { recursive: true });
  writeFileSync(join(root, "fail", name), match);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "member-user-cmd-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(SHIMS)) {
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!/usr/bin/env bash
printf '%s' "${name}" >> "$T/log"; printf ' %q' "$@" >> "$T/log"; echo >> "$T/log"
if [[ -e $T/fail/${name} ]]; then m=$(cat "$T/fail/${name}"); [[ -z $m || " $* " == *"$m"* ]] && exit 1; fi
${body}
`,
    );
    chmodSync(path, 0o755);
  }
  for (const dir of ["state", "systemd", "etc"]) mkdirSync(join(root, dir));
  // admin.sock: a real socket file (the command checks -S).
  spawnSync("python3", [
    "-I",
    "-c",
    "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
    join(root, "state", "admin.sock"),
  ]);
  writeFileSync(
    join(root, "update.conf"),
    `SERVICE_USER=office\nSTATE_ROOT=${root}/state\nSERVICE_KIND=system\nDEPLOYMENT_KIND=git\n`,
  );
  answer("info", 200, {
    ok: true,
    userId: USER_ID,
    name: "Alice",
    role: "member",
    slug: "alice",
    osUser: null,
    state: "none",
  });
  answer("prepare", 200, { ok: true, hash: "a".repeat(64) });
  answer("go-on", 200, { ok: true, ready: true });
  answer("disable", 200, { ok: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(...args: string[]) {
  const result = spawnSync("bash", [COMMAND, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: `${root}/bin:/usr/bin:/bin`,
      T: root,
      OS_USER,
      SHARE_ROOT: `${root}/share`,
      ISOMUX_MEMBER_USER_CONF: join(root, "update.conf"),
      ISOMUX_MEMBER_USER_SHARE_ROOT: join(root, "share"),
      ISOMUX_MEMBER_USER_ETC: join(root, "etc"),
      ISOMUX_MEMBER_USER_SYSTEMD_DIR: join(root, "systemd"),
      ISOMUX_MEMBER_USER_HELPER: "/helper",
    },
  });
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

// The logged calls, one string each.
const log = (): string[] =>
  existsSync(join(root, "log"))
    ? readFileSync(join(root, "log"), "utf8").split("\n").filter(Boolean)
    : [];
const called = (prefix: string) =>
  log().some((line) => line.startsWith(prefix));
const at = (prefix: string) =>
  log().findIndex((line) => line.startsWith(prefix));
const sent = (verb: string) =>
  existsSync(join(root, `sent-${verb}`))
    ? JSON.parse(readFileSync(join(root, `sent-${verb}`), "utf8"))
    : null;
const share = () => join(root, "share", OS_USER);
const etc = (name: string) => join(root, "etc", name);

// Nothing of the enable is left: no user, no share, no marks, the unit and
// the linger undone when they were done.
function expectNothingLeft(): void {
  expect(existsSync(join(root, "users", OS_USER))).toBe(false);
  expect(existsSync(share())).toBe(false);
  expect(existsSync(etc(`${OS_USER}.made`))).toBe(false);
  expect(existsSync(etc(`${OS_USER}.env`))).toBe(false);
  // A unit whose enable was tried is disabled again, even when the start
  // failed: `enable --now` links the unit before it starts it, and a linked
  // unit of a removed user restarts every 5 s for good.
  if (called("systemctl enable"))
    expect(called("systemctl disable --now")).toBe(true);
  // A linger that was enabled is disabled again.
  if (
    called("loginctl enable-linger") &&
    !existsSync(join(root, "fail", "loginctl"))
  )
    expect(called("loginctl disable-linger")).toBe(true);
}

describe("enable", () => {
  it("makes the user, the share and the marks, has the office prepare, starts the unit, then asks the office to go on", () => {
    const result = run("enable", "Alice");
    expect(result.code).toBe(0);
    // The order: no change before the office has answered info; prepare
    // before the unit; the root check before go-on.
    for (const [a, b] of [
      ["getent passwd", "useradd"],
      ["useradd", "install -d"],
      ["install -d", "loginctl enable-linger"],
      ["loginctl enable-linger", "systemctl enable --now"],
      ["systemctl enable --now", "sudo -n -l -U"],
    ])
      expect([a, b, at(a) < at(b), at(a) >= 0]).toEqual([a, b, true, true]);
    expect(log()).toContain(
      `useradd --create-home --user-group --shell /bin/bash ${OS_USER}`,
    );
    expect(log()).toContain(`systemctl enable --now ${UNIT}`);
    expect(called("userdel")).toBe(false);
    // The office gets the uid of the user database and the member's id.
    expect(sent("prepare")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 2001,
    });
    expect(sent("go-on")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 2001,
    });
    expect(readFileSync(etc(`${OS_USER}.made`), "utf8").trim()).toBe(USER_ID);
    expect(statSync(etc(`${OS_USER}.made`)).mode & 0o777).toBe(0o600);
    expect(readFileSync(etc(`${OS_USER}.env`), "utf8")).toBe(
      "ISOMUX_OFFICE_UID=1000\n",
    );
    expect(statSync(share()).mode & 0o7777).toBe(0o2750);
    expect(statSync(join(root, "home", OS_USER)).mode & 0o777).toBe(0o700);
  });

  it("takes --user, and refuses a name that is not a user name", () => {
    expect(run("enable", "Alice", "--user", "isomux-x/../y").code).toBe(1);
    expect(called("useradd")).toBe(false);
  });

  const refusals: [string, () => void][] = [
    [
      "the member is an owner",
      () =>
        answer("info", 200, {
          ok: true,
          userId: USER_ID,
          role: "owner",
          slug: "alice",
          osUser: null,
        }),
    ],
    [
      "the member already runs as an OS user",
      () =>
        answer("info", 200, {
          ok: true,
          userId: USER_ID,
          role: "member",
          slug: "alice",
          osUser: { name: "isomux-old", uid: 2999 },
        }),
    ],
    [
      "the office does not know the member",
      () =>
        answer("info", 404, {
          ok: false,
          error: "no_member",
          message: "no such member",
        }),
    ],
    [
      "the office is not ready for it",
      () =>
        answer("info", 409, {
          ok: false,
          error: "not_ready",
          message: "not yet",
        }),
    ],
    [
      "the OS user exists",
      () => {
        mkdirSync(join(root, "users"), { recursive: true });
        writeFileSync(join(root, "users", OS_USER), "");
      },
    ],
    [
      "it does not run as root",
      () => writeFileSync(join(root, "not-root"), ""),
    ],
    [
      "the install is a container",
      () =>
        writeFileSync(
          join(root, "update.conf"),
          `SERVICE_USER=office\nSTATE_ROOT=${root}/state\nDEPLOYMENT_KIND=container\n`,
        ),
    ],
    [
      "the install is user-level",
      () =>
        writeFileSync(
          join(root, "update.conf"),
          `SERVICE_USER=office\nSTATE_ROOT=${root}/state\nSERVICE_KIND=user\n`,
        ),
    ],
    [
      "the box does not run systemd",
      () => rmSync(join(root, "systemd"), { recursive: true }),
    ],
  ];
  for (const [name, setup] of refusals)
    it(`refuses before any change when ${name}`, () => {
      setup();
      const existed = existsSync(join(root, "users", OS_USER));
      const result = run("enable", "Alice");
      expect(result.code).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
      for (const change of [
        "useradd",
        "userdel",
        "install -d",
        "loginctl",
        "systemctl",
      ])
        expect([change, called(change)]).toEqual([change, false]);
      expect(sent("prepare")).toBeNull();
      expect(existsSync(join(root, "users", OS_USER))).toBe(existed);
    });

  // A failure after the first change: every change so far is undone, in
  // reverse, and the command says so.
  const failures: [string, () => void][] = [
    ["useradd fails", () => fail("useradd")],
    [
      "the office refuses prepare",
      () =>
        answer("prepare", 500, {
          ok: false,
          error: "prepare_failed",
          message: "disk full",
        }),
    ],
    ["the linger cannot be enabled", () => fail("loginctl", "enable-linger")],
    ["the unit does not start", () => fail("systemctl", "enable")],
    [
      "the user is in a privileged group",
      () => writeFileSync(join(root, "groups"), `${OS_USER} sudo\n`),
    ],
    [
      "sudo lists a rule for the user",
      () => {
        writeFileSync(
          join(root, "bin", "sudo"),
          '#!/bin/sh\necho "User may run the following commands: (ALL) ALL"\n',
        );
        chmodSync(join(root, "bin", "sudo"), 0o755);
      },
    ],
    [
      "the office does not take the OS user",
      () =>
        answer("go-on", 200, {
          ok: false,
          ready: false,
          reason: "the runner did not connect",
        }),
    ],
    [
      "the office answers go-on with an error",
      () =>
        answer("go-on", 409, {
          ok: false,
          error: "already_isolated",
          message: "no",
        }),
    ],
    // The office goes away mid-enable (a restart): no answer at all.
    [
      "the office does not answer prepare",
      () => rmSync(join(root, "answers", "prepare")),
    ],
    [
      "the office does not answer go-on",
      () => rmSync(join(root, "answers", "go-on")),
    ],
  ];
  for (const [name, setup] of failures)
    it(`undoes every change when ${name}`, () => {
      setup();
      const result = run("enable", "Alice");
      expect(result.code).toBe(1);
      expectNothingLeft();
      if (called("useradd") && !existsSync(join(root, "fail", "useradd")))
        expect(called(`userdel --remove ${OS_USER}`)).toBe(true);
      // The unit stops before the user's processes are ended and the user
      // is removed.
      if (called("systemctl disable"))
        expect(at("systemctl disable")).toBeLessThan(at("userdel"));
    });
});

describe("disable", () => {
  function isolated(made: string | null) {
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      slug: "alice",
      osUser: { name: OS_USER, uid: 2001 },
    });
    mkdirSync(join(root, "users"), { recursive: true });
    writeFileSync(join(root, "users", OS_USER), "");
    mkdirSync(share(), { recursive: true });
    writeFileSync(etc(`${OS_USER}.env`), "ISOMUX_OFFICE_UID=1000\n");
    if (made !== null) writeFileSync(etc(`${OS_USER}.made`), `${made}\n`);
  }

  it("asks the office first, then stops the unit and the user's work, removes the share and locks the user", () => {
    isolated(USER_ID);
    const result = run("disable", "Alice");
    expect(result.code).toBe(0);
    expect(sent("disable")).toEqual({ member: USER_ID });
    expect(at("systemctl disable --now")).toBeGreaterThan(-1);
    // The office stops using the host before the runner goes away.
    expect(log().filter((l) => l.startsWith("curl")).length).toBe(2);
    for (const step of [
      `systemctl disable --now ${UNIT}`,
      `loginctl terminate-user ${OS_USER}`,
      `loginctl disable-linger ${OS_USER}`,
      `crontab -r -u ${OS_USER}`,
      `usermod --lock --expiredate 1 ${OS_USER}`,
    ])
      expect([step, log().includes(step)]).toEqual([step, true]);
    expect(called("userdel")).toBe(false);
    expect(existsSync(share())).toBe(false);
    expect(existsSync(etc(`${OS_USER}.env`))).toBe(false);
    expect(existsSync(join(root, "users", OS_USER))).toBe(true);
  });

  it("deletes the user with --delete-user when this command made it for this member", () => {
    isolated(USER_ID);
    expect(run("disable", "Alice", "--delete-user").code).toBe(0);
    expect(log()).toContain(`userdel --remove ${OS_USER}`);
    expect(existsSync(etc(`${OS_USER}.made`))).toBe(false);
  });

  for (const [name, made] of [
    ["it did not make the user", null],
    ["it made the user for another member", "u-another"],
  ] as const)
    it(`refuses --delete-user before any change when ${name}`, () => {
      isolated(made);
      const result = run("disable", "Alice", "--delete-user");
      expect(result.code).toBe(1);
      expect(sent("disable")).toBeNull();
      for (const change of [
        "userdel",
        "usermod",
        "systemctl",
        "loginctl",
        "pkill",
        "crontab",
      ])
        expect([change, called(change)]).toEqual([change, false]);
      expect(existsSync(share())).toBe(true);
    });

  it("stops nothing when the office refuses", () => {
    isolated(USER_ID);
    answer("disable", 409, { ok: false, error: "not_ready", message: "no" });
    expect(run("disable", "Alice").code).toBe(1);
    expect(called("systemctl")).toBe(false);
    expect(existsSync(share())).toBe(true);
  });

  it("refuses a member with no OS user of their own", () => {
    expect(run("disable", "Alice").code).toBe(1);
    expect(sent("disable")).toBeNull();
  });
});

// Inside the container (DEPLOYMENT_KIND=inside-container): no systemd, and
// every change under /var/data/members goes through the helper, which works
// on checked folder fds; the command itself never makes, chmods or removes a
// path there, because the office user can replace /var/data/members.
describe("in the container", () => {
  const HELPER_CALL = "python3 -I /helper";
  const HOME = `/var/data/members/home/${OS_USER}`;
  beforeEach(() => {
    writeFileSync(
      join(root, "update.conf"),
      `SERVICE_USER=office\nSTATE_ROOT=${root}/state\nSERVICE_KIND=system\nDEPLOYMENT_KIND=inside-container\n`,
    );
    // No systemd in the container.
    rmSync(join(root, "systemd"), { recursive: true });
  });

  // The calls that change the box or the office, in order.
  const changes = () =>
    log().filter((line) =>
      [
        "python3",
        "groupadd",
        "groupdel",
        "useradd",
        "userdel",
        "usermod",
        "curl",
        "systemctl",
        "loginctl",
        "install",
        "chmod",
        "rm",
        "pkill",
      ].some((name) => line.startsWith(`${name} `)),
    );
  const curl = (verb: string) =>
    expect.stringMatching(new RegExp(`^curl .*/member-user/${verb}$`));

  it("enables with ids above every record, the helper for the folders, and the loop for the unit", () => {
    writeFileSync(join(root, "next-id"), "1007\n");
    const result = run("enable", "Alice");
    expect(result.code).toBe(0);
    expect(changes()).toEqual([
      curl("info"),
      `${HELPER_CALL} next-id`,
      `groupadd -g 1007 ${OS_USER}`,
      `useradd -M -u 1007 -g 1007 -d ${HOME} -s /bin/bash ${OS_USER}`,
      `${HELPER_CALL} add ${OS_USER} 1007 1007 ${USER_ID}`,
      curl("prepare"),
      `${HELPER_CALL} start ${OS_USER}`,
      curl("go-on"),
    ]);
    expect(sent("prepare")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 1007,
    });
    expect(sent("go-on")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 1007,
    });
    expect(existsSync(share())).toBe(false);
  });

  it("refuses before any change when the helper gives no number", () => {
    for (const setup of [
      () => fail("python3", "next-id"),
      () => writeFileSync(join(root, "next-id"), "1007; id\n"),
    ]) {
      rmSync(join(root, "log"), { force: true });
      rmSync(join(root, "fail"), { recursive: true, force: true });
      setup();
      expect(run("enable", "Alice").code).toBe(1);
      expect(changes()).toEqual([curl("info"), `${HELPER_CALL} next-id`]);
    }
  });

  // What each failing step leaves to undo, in the order of the undo: the
  // runner first, then the folders and the record, then the user and the
  // group. userdel never has --remove: the home goes through the helper.
  const undo = {
    loop: `${HELPER_CALL} stop ${OS_USER}`,
    record: `${HELPER_CALL} delete ${OS_USER} ${USER_ID}`,
    user: `userdel ${OS_USER}`,
    group: `groupdel ${OS_USER}`,
  };
  const all = [undo.loop, undo.record, undo.user, undo.group];
  const failures: [string, () => void, string[]][] = [
    ["groupadd fails", () => fail("groupadd"), []],
    ["useradd fails", () => fail("useradd"), [undo.group]],
    [
      "the helper cannot record the user",
      () => fail("python3", " add "),
      [undo.user, undo.group],
    ],
    [
      "the office cannot prepare",
      () => answer("prepare", 500, { ok: false, message: "no" }),
      [undo.record, undo.user, undo.group],
    ],
    ["the loop does not start", () => fail("python3", " start "), all],
    [
      "the user can become root",
      () => writeFileSync(join(root, "groups"), `${OS_USER} sudo\n`),
      all,
    ],
    [
      "the office does not take the user",
      () => answer("go-on", 200, { ok: true, ready: false, reason: "no" }),
      all,
    ],
    [
      "the office does not answer go-on",
      () => rmSync(join(root, "answers", "go-on")),
      all,
    ],
  ];
  for (const [name, setup, expected] of failures)
    it(`undoes in reverse when ${name}`, () => {
      setup();
      expect(run("enable", "Alice").code).toBe(1);
      const undone = changes().filter((line) =>
        [
          `${HELPER_CALL} stop`,
          `${HELPER_CALL} delete`,
          "userdel",
          "groupdel",
        ].some((p) => line.startsWith(p)),
      );
      expect(undone).toEqual(expected);
    });

  function isolatedHere() {
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      slug: "alice",
      osUser: { name: OS_USER, uid: 1007 },
    });
  }

  it("disable asks the office, stops the loop, then keeps the record locked", () => {
    isolatedHere();
    expect(run("disable", "Alice").code).toBe(0);
    expect(changes()).toEqual([
      curl("info"),
      curl("disable"),
      `${HELPER_CALL} stop ${OS_USER}`,
      `${HELPER_CALL} lock ${OS_USER}`,
      `usermod --lock --expiredate 1 ${OS_USER}`,
    ]);
  });

  it("disable --delete-user checks the mark first, and removes the folders through the helper before the user", () => {
    isolatedHere();
    expect(run("disable", "Alice", "--delete-user").code).toBe(0);
    expect(changes()).toEqual([
      curl("info"),
      `${HELPER_CALL} check-made ${OS_USER} ${USER_ID}`,
      curl("disable"),
      `${HELPER_CALL} stop ${OS_USER}`,
      `${HELPER_CALL} delete ${OS_USER} ${USER_ID}`,
      `userdel ${OS_USER}`,
      `groupdel ${OS_USER}`,
    ]);
  });

  it("disable --delete-user of a user it did not make changes nothing", () => {
    isolatedHere();
    fail("python3", "check-made");
    expect(run("disable", "Alice", "--delete-user").code).toBe(1);
    expect(changes()).toEqual([
      curl("info"),
      `${HELPER_CALL} check-made ${OS_USER} ${USER_ID}`,
    ]);
  });

  it("the container conf of the host still points to docker exec", () => {
    writeFileSync(
      join(root, "update.conf"),
      `SERVICE_USER=office\nSTATE_ROOT=${root}/state\nSERVICE_KIND=system\nDEPLOYMENT_KIND=container\n`,
    );
    expect(run("enable", "Alice").code).toBe(1);
    expect(changes()).toEqual([]);
  });
});

describe("the runner unit", () => {
  const text = readFileSync(UNIT_FILE, "utf8");
  const value = (key: string) =>
    text
      .split("\n")
      .filter((line) => line.startsWith(`${key}=`))
      .map((line) => line.slice(key.length + 1));

  it("runs the share's runtime as the member, with paths from the instance name only", () => {
    expect(value("User")).toEqual(["%i"]);
    const [exec] = value("ExecStart");
    const argv = exec.split(" ");
    // systemd does not expand a variable in the executable position.
    expect(argv[0]).toBe("/var/lib/isomux-share/%i/runtime/current/bun");
    expect(argv[1]).toBe("/var/lib/isomux-share/%i/runtime/current/runner.js");
    expect(argv.slice(2)).toEqual([
      "runner",
      "--socket",
      "/run/isomux-runner-%i/runner.sock",
      "--server-uid",
      "${ISOMUX_OFFICE_UID}",
      "--socket-mode",
      "0666",
    ]);
    expect(value("RuntimeDirectory")).toEqual(["isomux-runner-%i"]);
    expect(value("RuntimeDirectoryMode")).toEqual(["0711"]);
    expect(value("EnvironmentFile")).toEqual([
      "/etc/isomux/member-runner/%i.env",
    ]);
  });

  it("keeps restarting without a start limit, with no new privileges and a private /tmp", () => {
    expect(value("Restart")).toEqual(["always"]);
    expect(Number(value("RestartSec")[0])).toBeGreaterThan(0);
    expect(value("StartLimitIntervalSec")).toEqual(["0"]);
    expect(text.indexOf("StartLimitIntervalSec")).toBeLessThan(
      text.indexOf("[Service]"),
    );
    expect(value("NoNewPrivileges")).toEqual(["yes"]);
    expect(value("PrivateTmp")).toEqual(["yes"]);
  });
});

describe("install.sh", () => {
  it("installs the command and the unit from its embedded copies, root's (it runs as root), 0755 and 0644", () => {
    const out = join(root, "out");
    const script = `
set -euo pipefail
DRY_RUN=
MEMBER_USER_PATH=/usr/local/sbin/isomux-member-user
MEMBER_RUNNER_UNIT=/etc/systemd/system/isomux-member-runner@.service
write_file() { mkdir -p "$(dirname "${out}$1")"; cat > "${out}$1"; echo "$1 $2" >> "${out}/modes"; }
systemctl() { echo "systemctl $*" >> "${out}/modes"; }
eval "$(awk '/^install_member_user_command[(][)]/{f=1} f{print} f&&/^ISOMUX_MEMBER_RUNNER_UNIT$/{u=1} u&&/^}$/{exit}' "${REPO}/deploy/install.sh")"
install_member_user_command
`;
    mkdirSync(out);
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(
      readFileSync(join(out, "modes"), "utf8").split("\n").filter(Boolean),
    ).toEqual([
      "/usr/local/sbin/isomux-member-user 755",
      "/etc/systemd/system/isomux-member-runner@.service 644",
      "systemctl daemon-reload",
    ]);
    expect(
      readFileSync(join(out, "usr/local/sbin/isomux-member-user"), "utf8"),
    ).toBe(readFileSync(COMMAND, "utf8"));
    expect(
      readFileSync(
        join(out, "etc/systemd/system/isomux-member-runner@.service"),
        "utf8",
      ),
    ).toBe(text());
  });
  const text = () => readFileSync(UNIT_FILE, "utf8");
});
