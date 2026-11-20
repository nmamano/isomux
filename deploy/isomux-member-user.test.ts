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
  symlinkSync,
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
// The user the id, sudo and getent shims answer for (OS_USER, or the
// existing user of the task e15a82e7 cases).
let shimOsUser = OS_USER;

// One shim per external command. Each logs "name argv..." to $T/log, and
// fails when $T/fail/<name> exists (its content, when there is one, must
// appear in the argv).
const SHIMS: Record<string, string> = {
  id: `
if [[ $# == 1 && $1 == -u ]]; then [[ -e $T/not-root ]] && echo 1000 || echo 0; exit 0; fi
# Task e15a82e7: a user with a passwd line in $T/passwd/<name>.
if [[ ($1 == -u || $1 == -g) && -n \${2:-} && -e $T/passwd/$2 ]]; then
  [[ $1 == -u ]] && cut -d: -f3 "$T/passwd/$2" || cut -d: -f4 "$T/passwd/$2"; exit 0
fi
case "$1 $2" in
  "-u office") echo 1000 ;;
  "-u $OS_USER") [[ -e $T/users/$OS_USER ]] && echo 2001 || exit 1 ;;
  "-g $OS_USER") echo 3001 ;;
  "-Gn $OS_USER") cat "$T/groups" 2>/dev/null || echo "$OS_USER" ;;
  *) exit 1 ;;
esac`,
  getent: `
[[ $1 == passwd ]] || exit 2
# Task e15a82e7: a user with a passwd line in $T/passwd/<name>.
[[ -e $T/passwd/$2 ]] && { cat "$T/passwd/$2"; exit 0; }
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
# Task e15a82e7: $T/stat-owner lines "<path> <uid>" fake the owner (%u) of
# a path (a test user cannot chown).
owner=
[[ -e $T/stat-owner ]] && owner=$(awk -v p="\${path%/}" '$1 == p {print $2}' "$T/stat-owner")
if [[ $path == "$SHARE_ROOT" ]]; then printf '0 %s\\n' "$(command -p stat -c %a "$path")"
elif [[ -n $owner ]]; then
  args=("$@")
  for i in "\${!args[@]}"; do
    case \${args[i]} in
      -c|--format|--printf) args[i+1]=\${args[i+1]//%u/$owner} ;;
      -c*|--format=*|--printf=*) args[i]=\${args[i]//%u/$owner} ;;
    esac
  done
  command -p stat "\${args[@]}"
else command -p stat "$@"; fi`,
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
  // Slice 5c-2: the go-on loop waits between its calls; the log counts them.
  sleep: `:`,
  // The container's helper (python3 -I <helper> <verb> ...): next-id prints
  // $T/next-id, or 1005.
  python3: `
[[ $3 == next-id ]] && { cat "$T/next-id" 2>/dev/null || echo 1005; }
# Task 12c796b2: made-id prints the id in the mark ($T/made-id, else the
# member of these tests).
if [[ $3 == made-id ]]; then [[ -e $T/made-id ]] && cat "$T/made-id" || echo u-0123456789ab; fi
exit 0`,
  // The office: the answer to each verb is $T/answers/<verb> (body, then a
  // line with the status); a verb with no file answers 500.
  curl: `
url=\${@: -1}; verb=\${url##*/}
body=; prev=
for a in "$@"; do [[ $prev == --data ]] && body=$a; prev=$a; done
printf '%s\\n' "$body" > "$T/sent-$verb"
# $T/signal: the owner stops the command (that signal to it) during go-on.
if [[ $verb == go-on && -e $T/signal ]]; then
  p=$PPID
  until tr '\\0' ' ' <"/proc/$p/cmdline" | grep -q isomux-member-user.sh; do
    p=$(awk '{print $4}' "/proc/$p/stat"); ((p > 1)) || exit 9
  done
  kill -"$(cat "$T/signal")" "$p"; exit 7
fi
f=$T/answers/$verb
# Slice 5c-2: $T/answers/<verb>.<n> answers the n-th call of the verb (the
# last one repeats).
n=$(( $(cat "$T/count-$verb" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$T/count-$verb"
if [[ -e $f.1 ]]; then
  while (( n > 1 )) && [[ ! -e $f.$n ]]; do n=$((n - 1)); done
  f=$f.$n
fi
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
  shimOsUser = OS_USER;
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
# $T/term-on/<name>: this call (its argv holds the content) sends TERM to
# the command, as a restart or a second Ctrl-C does.
if [[ -e $T/term-on/${name} ]] && [[ " $* " == *"$(cat "$T/term-on/${name}")"* ]]; then
  p=$PPID
  until tr '\\0' ' ' <"/proc/$p/cmdline" | grep -q isomux-member-user.sh; do
    p=$(awk '{print $4}' "/proc/$p/stat"); ((p > 1)) || exit 9
  done
  kill -TERM "$p"
fi
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
    userName: OS_USER,
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
      OS_USER: shimOsUser,
      SHARE_ROOT: `${root}/share`,
      ISOMUX_MEMBER_USER_CONF: join(root, "update.conf"),
      ISOMUX_MEMBER_USER_SHARE_ROOT: join(root, "share"),
      ISOMUX_MEMBER_USER_ETC: join(root, "etc"),
      ISOMUX_MEMBER_USER_SYSTEMD_DIR: join(root, "systemd"),
      ISOMUX_MEMBER_USER_HELPER: "/helper",
      // Slice 5c-2: useradd's defaults, where its home base is read.
      ISOMUX_MEMBER_USER_USERADD_DEFAULTS: join(root, "useradd-defaults"),
      // Task e15a82e7: the uid range of login users, and the linger marks
      // (a file per user that lingers).
      ISOMUX_MEMBER_USER_LOGIN_DEFS: join(root, "login.defs"),
      ISOMUX_MEMBER_USER_LINGER_DIR: join(root, "linger"),
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
    // go-on moves the member's files: it waits above the office's worst
    // path (30 s + 3600 s + 2 x 1800 s); prepare keeps the short limit.
    const limit = (verb: string) =>
      Number(
        /--max-time (\d+)/.exec(
          log().find(
            (l) => l.startsWith("curl ") && l.endsWith(`/member-user/${verb}`),
          ) ?? "",
        )?.[1],
      );
    expect(limit("prepare")).toBe(120);
    expect(limit("go-on")).toBeGreaterThan(7230);
    expect(readFileSync(etc(`${OS_USER}.made`), "utf8").trim()).toBe(USER_ID);
    expect(statSync(etc(`${OS_USER}.made`)).mode & 0o777).toBe(0o600);
    expect(readFileSync(etc(`${OS_USER}.env`), "utf8")).toBe(
      "ISOMUX_OFFICE_UID=1000\n",
    );
    expect(statSync(share()).mode & 0o7777).toBe(0o2750);
    expect(statSync(join(root, "home", OS_USER)).mode & 0o777).toBe(0o700);
  });

  // Task 3b5234dc: with no --user, the new user's name is the one the office
  // gives (info's userName: the member's own name, or the next free one),
  // with nothing added.
  it("makes the user that the office names when no --user is given", () => {
    shimOsUser = "alice2";
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      name: "Alice",
      role: "member",
      userName: "alice2",
      osUser: null,
      state: "none",
    });
    const result = run("enable", "Alice");
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(log()).toContain(
      "useradd --create-home --user-group --shell /bin/bash alice2",
    );
    expect(sent("prepare")).toEqual({
      member: USER_ID,
      osUser: "alice2",
      uid: 2001,
    });
  });

  it("takes --user, and refuses a name that is not a user name", () => {
    expect(run("enable", "Alice", "--user", "isomux-x/../y").code).toBe(1);
    expect(called("useradd")).toBe(false);
  });

  const refusals: [string, () => void][] = [
    [
      "the member already runs as an OS user",
      () =>
        answer("info", 200, {
          ok: true,
          userId: USER_ID,
          role: "member",
          userName: OS_USER,
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
  ];
  // R2 (4c-iii): a stop signal during the undo (a restart sends TERM to
  // sudo and to the command, and sudo relays it) does not cut it short.
  it("finishes the undo when a stop signal comes during it", () => {
    fail("systemctl", "enable");
    mkdirSync(join(root, "term-on"), { recursive: true });
    writeFileSync(join(root, "term-on", "systemctl"), "disable --now");
    const result = run("enable", "Alice");
    expect(result.code).not.toBe(0);
    // The enabling condition: the signal came from the first undo step.
    expect(called("systemctl disable --now")).toBe(true);
    expect(called(`userdel --remove ${OS_USER}`)).toBe(true);
    expectNothingLeft();
  });

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

// An enable that the office cut during go-on (a restart, or the owner
// stopped the command): the office may have recorded the user, so the
// command undoes nothing, and a rerun of the same enable finishes it with
// nothing to undo (design 2.2).
describe("an enable that go-on did not finish", () => {
  // The office's record of the member, as info answers it after the cut.
  function recorded(over: { uid?: number; userName?: string } = {}) {
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: over.userName ?? OS_USER,
      osUser: { name: OS_USER, uid: over.uid ?? 2001 },
      state: "isolated",
    });
  }
  // Forget the first run's calls.
  function fresh(): void {
    rmSync(join(root, "log"), { force: true });
    for (const verb of ["info", "prepare", "go-on"])
      rmSync(join(root, `sent-${verb}`), { force: true });
  }
  function expectUserKept(): void {
    expect(existsSync(join(root, "users", OS_USER))).toBe(true);
    expect(readFileSync(etc(`${OS_USER}.made`), "utf8").trim()).toBe(USER_ID);
    expect(existsSync(share())).toBe(true);
    for (const undo of [
      "userdel",
      "systemctl disable",
      "loginctl disable-linger",
      "pkill",
    ])
      expect([undo, called(undo)]).toEqual([undo, false]);
  }
  const goOnAt = () =>
    log().findIndex(
      (l) => l.startsWith("curl ") && l.endsWith("/member-user/go-on"),
    );

  // Recorded: the office recorded the user before the cut (the member may
  // have a new name since: the record wins). Not recorded: the cut came
  // first.
  for (const [name, record] of [
    ["the office recorded the user", () => recorded({ userName: "renamed" })],
    ["the office did not record the user", () => {}],
  ] as const)
    it(`keeps the user when the office does not answer, and a rerun finishes when ${name}`, () => {
      rmSync(join(root, "answers", "go-on"));
      const cut = run("enable", "Alice");
      expect(cut.code).toBe(1);
      expect(cut.stderr.length).toBeGreaterThan(0);
      expect(sent("go-on")).not.toBeNull();
      expectUserKept();

      answer("go-on", 200, { ok: true, ready: true });
      record();
      fresh();
      const rerun = run("enable", "Alice");
      expect(rerun.code).toBe(0);
      expect(called("useradd")).toBe(false);
      expectUserKept();
      const body = { member: USER_ID, osUser: OS_USER, uid: 2001 };
      expect(sent("prepare")).toEqual(body);
      expect(sent("go-on")).toEqual(body);
      // The runner starts, and the root check runs, before go-on.
      for (const step of [
        "loginctl enable-linger",
        `systemctl enable --now ${UNIT}`,
        "sudo -n -l -U",
      ])
        expect([step, at(step) >= 0 && at(step) < goOnAt()]).toEqual([
          step,
          true,
        ]);
    });

  for (const [signal, code] of [
    ["INT", 130],
    ["TERM", 143],
  ] as const)
    it(`keeps the user when the owner stops the command with ${signal} during go-on`, () => {
      writeFileSync(join(root, "signal"), signal);
      const result = run("enable", "Alice");
      expect(result.code).toBe(code);
      expect(sent("go-on")).not.toBeNull();
      expectUserKept();
    });

  // F1: the office answers that it keeps its record (the files moved, or it
  // could not remove the record): the user and its home stay.
  it("keeps the user when the office answers go-on that it keeps its record", () => {
    answer("go-on", 200, {
      ok: false,
      ready: false,
      kept: true,
      reason: "the record still says the files move",
    });
    const result = run("enable", "Alice");
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expectUserKept();
  });

  it("undoes nothing when the office refuses the rerun's go-on", () => {
    rmSync(join(root, "answers", "go-on"));
    expect(run("enable", "Alice").code).toBe(1);
    answer("go-on", 200, { ok: false, ready: false, reason: "no runner" });
    recorded();
    fresh();
    const rerun = run("enable", "Alice");
    expect(rerun.code).toBe(1);
    expect(sent("go-on")).not.toBeNull();
    expectUserKept();
  });

  // The user that would be resumed is not one this command made for this
  // member as the office records it: no change, no call to the office past
  // info.
  const refusals: [string, () => void, string[]][] = [
    ["the office records another uid", () => recorded({ uid: 2999 }), []],
    [
      "the recorded user is no OS user here",
      () => {
        recorded();
        rmSync(join(root, "users", OS_USER));
      },
      [],
    ],
    [
      "this command did not make the user",
      () => {
        recorded();
        rmSync(etc(`${OS_USER}.made`));
      },
      [],
    ],
    [
      "--user names another user than the recorded one",
      () => recorded(),
      ["--user", "isomux-other"],
    ],
  ];
  for (const [name, setup, extra] of refusals)
    it(`refuses a rerun before any change when ${name}`, () => {
      rmSync(join(root, "answers", "go-on"));
      expect(run("enable", "Alice").code).toBe(1);
      answer("go-on", 200, { ok: true, ready: true });
      setup();
      fresh();
      const result = run("enable", "Alice", ...extra);
      expect(result.code).toBe(1);
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
      expect(sent("go-on")).toBeNull();
    });
});

// Slice 5c-2 (task 78733adf, E8, D1-D3): a member who came with an office
// move. The office records her with the old box's uid and no OS user here;
// enable makes the user as a fresh enable does, and go-on places her home as
// a job that the command asks after until it ends.
describe("a member who came with an office move", () => {
  function movedIn(): void {
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      name: "Alice",
      role: "member",
      userName: OS_USER,
      osUser: { name: OS_USER, uid: 1501 },
      state: "isolated",
      movedIn: true,
      oldHome: `${root}/home/${OS_USER}`,
    });
    writeFileSync(join(root, "useradd-defaults"), `HOME=${root}/home\n`);
  }
  function goOnAnswers(...bodies: object[]): void {
    rmSync(join(root, "answers", "go-on"), { force: true });
    bodies.forEach((body, i) => answer(`go-on.${i + 1}`, 200, body));
  }
  const goOnCalls = () =>
    log().filter(
      (l) => l.startsWith("curl ") && l.endsWith("/member-user/go-on"),
    ).length;

  it("makes her OS user as a fresh enable does, and asks go-on again while her home is placed, until it is ready", () => {
    movedIn();
    goOnAnswers(
      { ok: true, ready: false, running: true, placed: 1, total: 3 },
      { ok: true, ready: false, running: true, placed: 2, total: 3 },
      { ok: true, ready: true, warnings: [] },
    );
    const result = run("enable", "Alice");
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(log()).toContain(
      `useradd --create-home --user-group --shell /bin/bash ${OS_USER}`,
    );
    expect(goOnCalls()).toBe(3);
    // It waits between two calls.
    expect(log().filter((l) => l.startsWith("sleep")).length).toBeGreaterThan(
      1,
    );
    expect(sent("go-on")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 2001,
    });
    expect(called("userdel")).toBe(false);
  });

  it("refuses before any change when her home's path exists here before the user does", () => {
    movedIn();
    mkdirSync(join(root, "home", OS_USER), { recursive: true });
    writeFileSync(join(root, "home", OS_USER, "someone.txt"), "here before");
    const result = run("enable", "Alice");
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(called("useradd")).toBe(false);
    expect(goOnCalls()).toBe(0);
    expect(
      readFileSync(join(root, "home", OS_USER, "someone.txt"), "utf8"),
    ).toBe("here before");
  });

  it("D1: undoes the user it made when go-on refuses without kept (her home here is not her old one)", () => {
    movedIn();
    goOnAnswers({
      ok: false,
      ready: false,
      reason: "her home here differs from her home on the old machine",
    });
    const result = run("enable", "Alice");
    expect(result.code).toBe(1);
    expect(called("useradd")).toBe(true);
    expectNothingLeft();
  });

  it("keeps the user when the place fails after it started (kept), so the same enable resumes", () => {
    movedIn();
    goOnAnswers(
      { ok: true, ready: false, running: true, placed: 1, total: 3 },
      { ok: false, ready: false, kept: true, reason: "no room in her home" },
    );
    const result = run("enable", "Alice");
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(goOnCalls()).toBe(2);
    expect(existsSync(join(root, "users", OS_USER))).toBe(true);
    expect(readFileSync(etc(`${OS_USER}.made`), "utf8").trim()).toBe(USER_ID);
    expect(called("userdel")).toBe(false);
  });
});

describe("disable", () => {
  function isolated(made: string | null) {
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: OS_USER,
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

  // Slice 1c-ii-b: go-on and disable move files and wait for the office's
  // worst path; the other verbs keep the short limit.
  const limitOf = (verb: string) =>
    log()
      .filter(
        (l) => l.startsWith("curl ") && l.endsWith(`/member-user/${verb}`),
      )
      .map((l) => Number(/--max-time (\d+)/.exec(l)?.[1]));

  it("waits longer for disable than for info, and stops before the OS user when the office cannot move the files back", () => {
    isolated(USER_ID);
    answer("disable", 200, { ok: false, reason: "the runner is gone" });
    const result = run("disable", "Alice");
    expect(result.code).toBe(1);
    const [info] = limitOf("info");
    const [disable] = limitOf("disable");
    expect(info).toBe(120);
    // Above the office's worst path: 30 s + 3600 s + 2 x 1800 s.
    expect(disable).toBeGreaterThan(7230);
    for (const step of ["systemctl disable", "loginctl", "usermod --lock"])
      expect([step, called(step)]).toEqual([step, false]);
    expect(existsSync(share())).toBe(true);
  });

  it("asks the office to keep the files with --keep-files, and names the home they stay in", () => {
    isolated(USER_ID);
    answer("disable", 200, { ok: true, kept: true });
    const result = run("disable", "Alice", "--keep-files");
    expect(result.code).toBe(0);
    expect(sent("disable")).toEqual({ member: USER_ID, keepFiles: true });
    expect(result.stdout).toContain(OS_USER);
    expect(called(`usermod --lock`)).toBe(true);
  });

  // Task 29b5ba13: a member who came with an office move gives up her moved
  // home with its own flag; --keep-files never asks for that.
  it("asks the office to delete the moved home with --delete-moved-home, and sends no keepFiles", () => {
    isolated(USER_ID);
    answer("disable", 200, { ok: true, kept: true, movedHomeRemoved: true });
    const result = run("disable", "Alice", "--delete-moved-home");
    expect(result.code).toBe(0);
    expect(sent("disable")).toEqual({ member: USER_ID, deleteMovedHome: true });
  });

  it("does not take --delete-moved-home for enable, and asks the office nothing", () => {
    isolated(USER_ID);
    const result = run("enable", "Alice", "--delete-moved-home");
    expect(result.code).toBe(2);
    expect(log().filter((l) => l.startsWith("curl")).length).toBe(0);
  });

  it("deletes the user with --delete-user when this command made it for this member", () => {
    isolated(USER_ID);
    expect(run("disable", "Alice", "--delete-user").code).toBe(0);
    expect(log()).toContain(`userdel --remove ${OS_USER}`);
    expect(existsSync(etc(`${OS_USER}.made`))).toBe(false);
  });

  for (const [name, made] of [["it did not make the user", null]] as const)
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

// Task 12c796b2: several members on one OS user, and an owner on one. The
// root command adds a member to a user it made for another member (a join),
// reopens a made user that no member runs as any more, leaves a user that
// other members still run as when one of them is disabled, and runs one
// enable or disable per OS user at a time.
describe("several members on one OS user", () => {
  const OTHER = "u-first";
  // The user this command made for the first member on it, as a finished
  // enable left it.
  function madeForOther(onUser: string[], markId = OTHER): void {
    mkdirSync(join(root, "users"), { recursive: true });
    writeFileSync(join(root, "users", OS_USER), "");
    mkdirSync(join(root, "home", OS_USER), { recursive: true });
    mkdirSync(share(), { recursive: true });
    // The share root as root keeps it, whatever the test's umask.
    chmodSync(join(root, "share"), 0o755);
    chmodSync(share(), 0o2750);
    writeFileSync(etc(`${OS_USER}.made`), `${markId}\n`);
    writeFileSync(etc(`${OS_USER}.env`), "ISOMUX_OFFICE_UID=1000\n");
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: OS_USER,
      osUser: null,
      state: "none",
      onUser,
    });
  }
  // Nothing of the shared user was undone or ended.
  function expectSharedUserKept(markId = OTHER): void {
    expect(existsSync(join(root, "users", OS_USER))).toBe(true);
    expect(readFileSync(etc(`${OS_USER}.made`), "utf8")).toBe(`${markId}\n`);
    expect(existsSync(share())).toBe(true);
    expect(readFileSync(etc(`${OS_USER}.env`), "utf8")).toBe(
      "ISOMUX_OFFICE_UID=1000\n",
    );
    for (const step of [
      "useradd",
      "userdel",
      "usermod",
      "systemctl disable",
      "loginctl disable-linger",
      "loginctl terminate-user",
      "pkill",
      "crontab",
    ])
      expect([step, called(step)]).toEqual([step, false]);
  }

  it("makes an owner's OS user as a member's", () => {
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "owner",
      userName: OS_USER,
      osUser: null,
      state: "none",
    });
    const result = run("enable", "Alice");
    expect(result.code).toBe(0);
    expect(log()).toContain(
      `useradd --create-home --user-group --shell /bin/bash ${OS_USER}`,
    );
    expect(sent("go-on")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 2001,
    });
  });

  for (const extra of [[], ["--user", OS_USER]])
    it(`joins a user it made for another member${extra.length ? " named by --user" : ""}: no new user, the mark as it was, prepare and go-on with its uid`, () => {
      madeForOther(["Bob"]);
      const result = run("enable", "Alice", ...extra);
      expect(result.code).toBe(0);
      const body = { member: USER_ID, osUser: OS_USER, uid: 2001 };
      expect(sent("prepare")).toEqual(body);
      expect(sent("go-on")).toEqual(body);
      expectSharedUserKept();
      // The root check still runs before go-on.
      expect(at("sudo -n -l -U")).toBeGreaterThan(-1);
    });

  // The page offers a made user among the existing users, and its command
  // says --existing-user: on a user with a .made mark that flag joins as
  // --user does.
  it("joins a user it made for another member when named by --existing-user", () => {
    madeForOther(["Bob"]);
    const result = run("enable", "Alice", "--existing-user", OS_USER);
    expect(result.code).toBe(0);
    expect(sent("go-on")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 2001,
    });
    expectSharedUserKept();
  });

  it("undoes nothing of the user when the office refuses the join's go-on", () => {
    madeForOther(["Bob"]);
    answer("go-on", 200, {
      ok: false,
      ready: false,
      reason: "the runner did not connect",
    });
    const result = run("enable", "Alice");
    expect(result.code).toBe(1);
    expect(sent("go-on")).not.toBeNull();
    expectSharedUserKept();
  });

  // D7: a made user whose last member was disabled without --delete-user:
  // its account expired at the disable, and its share went.
  it("reopens a made user that no member runs as: the expiry cleared, the share and the unit again, then go-on", () => {
    madeForOther([]);
    rmSync(share(), { recursive: true });
    const result = run("enable", "Alice");
    expect(result.code).toBe(0);
    const reopen = log().findIndex((l) =>
      /^usermod .*(--expiredate|-e) '' isomux-alice$/.test(l),
    );
    expect(reopen).toBeGreaterThan(-1);
    expect(at(`systemctl enable --now ${UNIT}`)).toBeGreaterThan(reopen);
    expect(statSync(share()).mode & 0o7777).toBe(0o2750);
    expect(sent("go-on")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 2001,
    });
    expect(called("useradd")).toBe(false);
    expect(readFileSync(etc(`${OS_USER}.made`), "utf8")).toBe(`${OTHER}\n`);
  });

  it("expires a reopened user again, and keeps it, when the office refuses its go-on", () => {
    madeForOther([]);
    rmSync(share(), { recursive: true });
    answer("go-on", 200, {
      ok: false,
      ready: false,
      reason: "the runner did not connect",
    });
    const result = run("enable", "Alice");
    expect(result.code).toBe(1);
    expect(
      log().some((l) =>
        /^usermod .*(--expiredate|-e) 1( |$).*isomux-alice$/.test(l),
      ),
    ).toBe(true);
    expect(called("userdel")).toBe(false);
    expect(existsSync(join(root, "users", OS_USER))).toBe(true);
    expect(existsSync(share())).toBe(false);
    expect(readFileSync(etc(`${OS_USER}.made`), "utf8")).toBe(`${OTHER}\n`);
    if (called("systemctl enable"))
      expect(called(`systemctl disable --now ${UNIT}`)).toBe(true);
  });

  function sharedDisable(
    disableAnswer: object,
    onUser = ["Bob"],
    markId = OTHER,
  ): void {
    madeForOther(onUser, markId);
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: OS_USER,
      osUser: { name: OS_USER, uid: 2001 },
      state: "isolated",
      onUser,
    });
    answer("disable", 200, disableAnswer);
  }

  for (const extra of [[], ["--keep-files"]])
    it(`changes nothing on the user when other members still run as it${extra.length ? " (--keep-files)" : ""}`, () => {
      sharedDisable({
        ok: true,
        userStays: true,
        ...(extra.length ? { kept: true } : {}),
      });
      const result = run("disable", "Alice", ...extra);
      expect(result.code).toBe(0);
      expect(sent("disable")).toEqual({
        member: USER_ID,
        ...(extra.length ? { keepFiles: true } : {}),
      });
      expectSharedUserKept();
      expect(called("systemctl")).toBe(false);
    });

  // The mark names Alice, so only the other members can refuse.
  it("refuses --delete-user before any change while other members run as the user", () => {
    sharedDisable({ ok: true, userStays: true }, ["Bob"], USER_ID);
    const result = run("disable", "Alice", "--delete-user");
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(sent("disable")).toBeNull();
    expectSharedUserKept(USER_ID);
    expect(called("systemctl")).toBe(false);
  });

  it("tears the user down at the disable of the last member on it, whoever's id the mark holds", () => {
    sharedDisable({ ok: true }, []);
    const result = run("disable", "Alice", "--delete-user");
    expect(result.code).toBe(0);
    expect(log()).toContain(`systemctl disable --now ${UNIT}`);
    expect(log()).toContain(`userdel --remove ${OS_USER}`);
    expect(existsSync(etc(`${OS_USER}.made`))).toBe(false);
  });

  // D1: one enable or disable per OS user at a time; a second refuses at
  // once, before any change (a go-on can run for hours).
  describe("while another enable or disable of the user runs", () => {
    let holder: ReturnType<typeof Bun.spawn> | null = null;
    afterEach(() => {
      holder?.kill();
      holder = null;
    });
    function hold(): void {
      const lock = etc(`${OS_USER}.lock`);
      // -o: the sleep does not hold the lock, so a kill of flock frees it.
      holder = Bun.spawn(["flock", "-o", lock, "sleep", "30"]);
      // Held once flock -n cannot take it.
      for (let i = 0; i < 200; i++) {
        if (spawnSync("flock", ["-n", lock, "true"]).status !== 0) return;
        spawnSync("sleep", ["0.01"]);
      }
      throw new Error("the lock was never held");
    }

    it("refuses an enable before any change, and a disable before it asks the office to disable", async () => {
      madeForOther(["Bob"]);
      hold();
      const enable = run("enable", "Alice");
      expect(enable.code).not.toBe(0);
      expect(enable.stderr.length).toBeGreaterThan(0);
      expect(sent("prepare")).toBeNull();
      expect(sent("go-on")).toBeNull();
      sharedDisable({ ok: true });
      const disable = run("disable", "Alice");
      expect(disable.code).not.toBe(0);
      expect(sent("disable")).toBeNull();
      expectSharedUserKept();
      expect(called("systemctl")).toBe(false);
      expect(called("install -d")).toBe(false);
      // The enabling condition: once it is free, the same enable joins.
      holder!.kill();
      await holder!.exited;
      holder = null;
      madeForOther(["Bob"]);
      expect(run("enable", "Alice").code).toBe(0);
    });
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
    // Task 12c796b2: the second info, under the lock, asks who runs as
    // the user.
    expect(changes()).toEqual([
      curl("info"),
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
      expect(changes()).toEqual([
        curl("info"),
        curl("info"),
        `${HELPER_CALL} next-id`,
      ]);
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

  // An enable that the office cut during go-on: nothing is undone, and a
  // rerun checks the helper's mark, then starts the loop and goes on, with
  // no new user and nothing to undo.
  it("keeps the user when the office does not answer go-on, and a rerun finishes it", () => {
    rmSync(join(root, "answers", "go-on"));
    expect(run("enable", "Alice").code).toBe(1);
    const undoes = (line: string) =>
      [
        `${HELPER_CALL} stop`,
        `${HELPER_CALL} delete`,
        "userdel",
        "groupdel",
      ].some((p) => line.startsWith(p));
    expect(changes().filter(undoes)).toEqual([]);

    answer("go-on", 200, { ok: true, ready: true });
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: OS_USER,
      osUser: { name: OS_USER, uid: 2001 },
    });
    rmSync(join(root, "log"));
    expect(run("enable", "Alice").code).toBe(0);
    expect(changes()).toEqual([
      curl("info"),
      curl("info"),
      `${HELPER_CALL} made-id ${OS_USER}`,
      curl("prepare"),
      `${HELPER_CALL} start ${OS_USER}`,
      curl("go-on"),
    ]);
  });

  it("keeps the user when the office answers go-on that it keeps its record", () => {
    answer("go-on", 200, { ok: false, ready: false, kept: true, reason: "no" });
    expect(run("enable", "Alice").code).toBe(1);
    const undoes = (line: string) =>
      [
        `${HELPER_CALL} stop`,
        `${HELPER_CALL} delete`,
        "userdel",
        "groupdel",
      ].some((p) => line.startsWith(p));
    expect(changes().filter(undoes)).toEqual([]);
  });

  it("refuses a rerun before any change when the helper did not make the user", () => {
    rmSync(join(root, "answers", "go-on"));
    expect(run("enable", "Alice").code).toBe(1);
    answer("go-on", 200, { ok: true, ready: true });
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: OS_USER,
      osUser: { name: OS_USER, uid: 2001 },
    });
    fail("python3", "made-id");
    rmSync(join(root, "log"));
    expect(run("enable", "Alice").code).toBe(1);
    expect(changes()).toEqual([
      curl("info"),
      curl("info"),
      `${HELPER_CALL} made-id ${OS_USER}`,
    ]);
  });

  function isolatedHere() {
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: OS_USER,
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
      `${HELPER_CALL} made-id ${OS_USER}`,
      curl("disable"),
      `${HELPER_CALL} stop ${OS_USER}`,
      `${HELPER_CALL} delete ${OS_USER} ${USER_ID}`,
      `userdel ${OS_USER}`,
      `groupdel ${OS_USER}`,
    ]);
  });

  it("disable --delete-user of a user it did not make changes nothing", () => {
    isolatedHere();
    fail("python3", "made-id");
    expect(run("disable", "Alice", "--delete-user").code).toBe(1);
    expect(changes()).toEqual([
      curl("info"),
      `${HELPER_CALL} made-id ${OS_USER}`,
    ]);
  });

  // Task 12c796b2: a user the helper made for another member. A join starts
  // no loop (the helper's start ends every process of the uid, the other
  // members' runner included); a reopen of a user no member runs as clears
  // the record's lock first; a disable of one of several changes nothing.
  function madeHereForOther(onUser: string[], osUser: object | null): void {
    mkdirSync(join(root, "users"), { recursive: true });
    writeFileSync(join(root, "users", OS_USER), "");
    writeFileSync(join(root, "made-id"), "u-first\n");
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: OS_USER,
      osUser,
      state: osUser ? "isolated" : "none",
      onUser,
    });
  }
  const makesOrEnds = (line: string) =>
    [
      `${HELPER_CALL} next-id`,
      `${HELPER_CALL} add`,
      `${HELPER_CALL} start`,
      `${HELPER_CALL} stop`,
      `${HELPER_CALL} delete`,
      `${HELPER_CALL} lock`,
      "groupadd",
      "groupdel",
      "useradd",
      "userdel",
      "usermod",
    ].some((p) => line.startsWith(p));

  it("joins a user the helper made for another member: no new user, no loop start, prepare and go-on", () => {
    madeHereForOther(["Bob"], null);
    expect(run("enable", "Alice").code).toBe(0);
    expect(changes().filter(makesOrEnds)).toEqual([]);
    const body = { member: USER_ID, osUser: OS_USER, uid: 2001 };
    expect(sent("prepare")).toEqual(body);
    expect(sent("go-on")).toEqual(body);
  });

  it("undoes nothing of a joined user when the office refuses go-on", () => {
    madeHereForOther(["Bob"], null);
    answer("go-on", 200, { ok: false, ready: false, reason: "no" });
    expect(run("enable", "Alice").code).toBe(1);
    expect(sent("go-on")).not.toBeNull();
    expect(changes().filter(makesOrEnds)).toEqual([]);
  });

  it("reopens a user the helper made that no member runs as: unlock, then the loop, then go-on", () => {
    madeHereForOther([], null);
    expect(run("enable", "Alice").code).toBe(0);
    const unlock = changes().indexOf(`${HELPER_CALL} unlock ${OS_USER}`);
    const start = changes().indexOf(`${HELPER_CALL} start ${OS_USER}`);
    expect(unlock).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(unlock);
    expect(sent("go-on")).toEqual({
      member: USER_ID,
      osUser: OS_USER,
      uid: 2001,
    });
    expect(called("useradd")).toBe(false);
  });

  it("disable of one of several members on the user stops nothing and keeps the record open", () => {
    madeHereForOther(["Bob"], { name: OS_USER, uid: 2001 });
    answer("disable", 200, { ok: true, userStays: true });
    expect(run("disable", "Alice").code).toBe(0);
    expect(sent("disable")).toEqual({ member: USER_ID });
    expect(changes().filter(makesOrEnds)).toEqual([]);
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

// Task e15a82e7: enable --existing-user runs the member's agents as a
// person's existing OS user. Root adds only Isomux's parts (the share, the
// env file, the linger, the unit and a root-owned .adopted mark). It never
// makes, changes, locks or deletes the user or its home, and never ends the
// user's processes: they include the person's own sessions. disable removes
// only Isomux's parts, and puts the linger back as it was before the enable.
describe("an existing OS user", () => {
  const PERSON = "alice";
  const PERSON_UID = 2002;
  const PERSON_UNIT = `isomux-member-runner@${PERSON}.service`;
  const home = () => join(root, "people", PERSON);
  const mark = () => etc(`${PERSON}.adopted`);
  const personShare = () => join(root, "share", PERSON);

  function passwd(name: string, line: string): void {
    mkdirSync(join(root, "passwd"), { recursive: true });
    writeFileSync(join(root, "passwd", name), `${line}\n`);
  }
  // One line per path: a second call for a path replaces its line.
  function owner(path: string, uid: number): void {
    const file = join(root, "stat-owner");
    const old = existsSync(file) ? readFileSync(file, "utf8") : "";
    const kept = old
      .split("\n")
      .filter((l) => l && !l.startsWith(`${path} `))
      .map((l) => `${l}\n`)
      .join("");
    writeFileSync(file, `${kept}${path} ${uid}\n`);
  }
  // The person: a passwd line, a home of their own (0750, with a file of
  // theirs in it). Each field can be changed for one case.
  function person(
    over: { uid?: number; home?: string; shell?: string } = {},
  ): void {
    const uid = over.uid ?? PERSON_UID;
    passwd(
      PERSON,
      `${PERSON}:x:${uid}:${uid}:Alice:${over.home ?? home()}:${over.shell ?? "/bin/bash"}`,
    );
    owner(home(), uid);
    owner(join(home(), ".isomux-agent"), uid);
  }
  function lingers(): void {
    mkdirSync(join(root, "linger"), { recursive: true });
    writeFileSync(join(root, "linger", PERSON), "");
  }
  function memberInfo(osUser: { name: string; uid: number } | null): void {
    answer("info", 200, {
      ok: true,
      userId: USER_ID,
      role: "member",
      userName: OS_USER,
      osUser,
      ...(osUser ? { state: "isolated" } : { state: "none" }),
    });
  }
  // Forget the calls of an earlier run.
  function fresh(): void {
    rmSync(join(root, "log"), { force: true });
    for (const verb of ["info", "prepare", "go-on", "disable"])
      rmSync(join(root, `sent-${verb}`), { force: true });
  }
  const adopt = (...extra: string[]) =>
    run("enable", "Alice", "--existing-user", PERSON, ...extra);

  beforeEach(() => {
    shimOsUser = PERSON;
    mkdirSync(home(), { recursive: true });
    chmodSync(home(), 0o750);
    writeFileSync(join(home(), "notes.txt"), "the person's own file\n");
    mkdirSync(join(root, "office-home"));
    passwd("office", `office:x:1000:1000::${root}/office-home:/bin/bash`);
    person();
  });

  // The person's account and home are as they were.
  function expectPersonUntouched(): void {
    for (const change of ["useradd", "userdel", "usermod", "pkill"])
      expect([change, called(change)]).toEqual([change, false]);
    expect(called("loginctl terminate-user")).toBe(false);
    expect(called("crontab -r")).toBe(false);
    expect(existsSync(join(root, "passwd", PERSON))).toBe(true);
    expect(statSync(home()).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(home(), "notes.txt"), "utf8")).toBe(
      "the person's own file\n",
    );
  }
  // None of Isomux's parts are left.
  function expectNoIsomuxParts(): void {
    expect(existsSync(personShare())).toBe(false);
    expect(existsSync(etc(`${PERSON}.env`))).toBe(false);
    expect(existsSync(mark())).toBe(false);
    expect(existsSync(etc(`${PERSON}.made`))).toBe(false);
  }
  const goOnAt = () =>
    log().findIndex(
      (l) => l.startsWith("curl ") && l.endsWith("/member-user/go-on"),
    );

  it("adds the share, the mark, the linger and the unit, has the office prepare, and tells go-on the user is adopted", () => {
    const result = adopt();
    expect(result.code).toBe(0);
    expectPersonUntouched();
    expect(readFileSync(mark(), "utf8").split("\n")[0]).toBe(USER_ID);
    expect(statSync(mark()).mode & 0o777).toBe(0o600);
    expect(existsSync(etc(`${PERSON}.made`))).toBe(false);
    expect(statSync(personShare()).mode & 0o7777).toBe(0o2750);
    expect(readFileSync(etc(`${PERSON}.env`), "utf8")).toBe(
      "ISOMUX_OFFICE_UID=1000\n",
    );
    expect(log()).toContain(`loginctl enable-linger ${PERSON}`);
    expect(log()).toContain(`systemctl enable --now ${PERSON_UNIT}`);
    expect(sent("prepare")).toEqual({
      member: USER_ID,
      osUser: PERSON,
      uid: PERSON_UID,
    });
    expect(sent("go-on")).toEqual({
      member: USER_ID,
      osUser: PERSON,
      uid: PERSON_UID,
      adopted: true,
    });
    // The root check runs before go-on, after the unit.
    expect(at("sudo -n -l -U")).toBeGreaterThan(at("systemctl enable --now"));
    expect(at("sudo -n -l -U")).toBeLessThan(goOnAt());
  });

  it("reads the uid range of login users from login.defs", () => {
    writeFileSync(
      join(root, "login.defs"),
      "# a comment\nUID_MIN\t\t\t  500\nUID_MAX\t\t\t60000\n",
    );
    person({ uid: 600 });
    expect(adopt().code).toBe(0);
    expect(sent("go-on")?.uid).toBe(600);
  });

  it("takes an agent space that an earlier enable left: a 0700 folder of the user", () => {
    mkdirSync(join(home(), ".isomux-agent"), { mode: 0o700 });
    chmodSync(join(home(), ".isomux-agent"), 0o700);
    expect(adopt().code).toBe(0);
  });

  it("does not take --user and --existing-user together", () => {
    const result = run(
      "enable",
      "Alice",
      "--user",
      "isomux-x",
      "--existing-user",
      PERSON,
    );
    expect(result.code).toBe(2);
    expect(log().filter((l) => l.startsWith("curl")).length).toBe(0);
  });

  // Each case changes one property of the person, the member or the box.
  const refusals: [string, () => void, string?][] = [
    ["the user does not exist", () => {}, "carol"],
    ["the name is not a user name", () => {}, "alice/../x"],
    ["the uid is 0", () => person({ uid: 0 })],
    ["the uid is the office's", () => person({ uid: 1000 })],
    [
      "the user is the office's user",
      () => owner(join(root, "office-home"), 1000),
      "office",
    ],
    ["the uid is below the login range", () => person({ uid: 999 })],
    ["the uid is above the login range", () => person({ uid: 60001 })],
    [
      "login.defs puts the uid below the login range",
      () => writeFileSync(join(root, "login.defs"), "UID_MIN 3000\n"),
    ],
    ["the shell is nologin", () => person({ shell: "/usr/sbin/nologin" })],
    ["the shell is false", () => person({ shell: "/bin/false" })],
    [
      "another uid owns the home",
      () => {
        writeFileSync(join(root, "stat-owner"), "");
        owner(home(), 2999);
      },
    ],
    [
      "the home is a link",
      () => {
        const link = join(root, "people", "link");
        symlinkSync(home(), link);
        person({ home: link });
        owner(link, PERSON_UID);
      },
    ],
    [
      "the home does not exist",
      () => person({ home: join(root, "people", "gone") }),
    ],
    ["the home is /", () => person({ home: "/" })],
    [
      "the home is not normalised",
      () => {
        // The same folder, owned by the user: only the path's form differs.
        const odd = `${root}/people/../people/${PERSON}`;
        person({ home: odd });
        owner(odd, PERSON_UID);
      },
    ],
    [
      "the home is in the office's state root",
      () => {
        const inState = join(root, "state", PERSON);
        mkdirSync(inState);
        person({ home: inState });
        owner(inState, PERSON_UID);
      },
    ],
    [
      "the home is the office's home",
      () => {
        person({ home: join(root, "office-home") });
        owner(join(root, "office-home"), PERSON_UID);
      },
    ],
    [
      "the home holds the office's home",
      () => {
        const officeHome = join(home(), "office");
        mkdirSync(officeHome);
        passwd("office", `office:x:1000:1000::${officeHome}:/bin/bash`);
      },
    ],
    [
      "the agent space is open to others",
      () => mkdirSync(join(home(), ".isomux-agent"), { mode: 0o755 }),
    ],
    [
      "the agent space is a link",
      () => {
        mkdirSync(join(root, "elsewhere"), { mode: 0o700 });
        symlinkSync(join(root, "elsewhere"), join(home(), ".isomux-agent"));
      },
    ],
    [
      "another uid owns the agent space",
      () => {
        mkdirSync(join(home(), ".isomux-agent"), { mode: 0o700 });
        writeFileSync(join(root, "stat-owner"), "");
        owner(home(), PERSON_UID);
        owner(join(home(), ".isomux-agent"), 2999);
      },
    ],
    [
      "the member already runs as another OS user",
      () => memberInfo({ name: "isomux-old", uid: 2999 }),
    ],
    [
      "the install is the container's",
      () => {
        writeFileSync(
          join(root, "update.conf"),
          `SERVICE_USER=office\nSTATE_ROOT=${root}/state\nSERVICE_KIND=system\nDEPLOYMENT_KIND=inside-container\n`,
        );
        rmSync(join(root, "systemd"), { recursive: true });
      },
    ],
  ];
  for (const [name, setup, user] of refusals)
    it(`refuses before any change when ${name}`, () => {
      setup();
      const result = run("enable", "Alice", "--existing-user", user ?? PERSON);
      expect(result.code).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
      for (const change of [
        "useradd",
        "userdel",
        "usermod",
        "groupadd",
        "install -d",
        "loginctl",
        "systemctl",
        "pkill",
        "python3",
      ])
        expect([change, called(change)]).toEqual([change, false]);
      expect(sent("prepare")).toBeNull();
      expect(sent("go-on")).toBeNull();
      expect(existsSync(personShare())).toBe(false);
      expect(existsSync(etc(`${PERSON}.env`))).toBe(false);
      expect(statSync(home()).mode & 0o777).toBe(0o750);
    });

  // A failure after the first change: Isomux's parts go, the person's
  // account, home and processes stay, and the linger is as it was.
  const failures: [string, () => void][] = [
    [
      "the office refuses prepare",
      () =>
        answer("prepare", 500, {
          ok: false,
          error: "prepare_failed",
          message: "disk full",
        }),
    ],
    ["the unit does not start", () => fail("systemctl", "enable")],
    [
      "the office does not take the OS user",
      () =>
        answer("go-on", 200, {
          ok: false,
          ready: false,
          reason: "the runner did not connect",
        }),
    ],
  ];
  for (const [name, setup] of failures)
    for (const lingered of [false, true])
      it(`undoes only its own parts when ${name}, with the linger ${lingered ? "on" : "off"} before`, () => {
        setup();
        if (lingered) lingers();
        const result = adopt();
        expect(result.code).toBe(1);
        expectPersonUntouched();
        expectNoIsomuxParts();
        if (called("systemctl enable"))
          expect(log()).toContain(`systemctl disable --now ${PERSON_UNIT}`);
        // The linger was enabled before each of these failures.
        expect(log()).toContain(`loginctl enable-linger ${PERSON}`);
        expect(log().includes(`loginctl disable-linger ${PERSON}`)).toBe(
          !lingered,
        );
      });

  // Nil, 2026-11-17: a person's user that can become root is accepted, and
  // the page warns. go-on hears rootCapable; a user the command makes is
  // still refused (the enable cases above).
  const rootWays: [string, () => void][] = [
    [
      "in a privileged group",
      () => writeFileSync(join(root, "groups"), `${PERSON} sudo\n`),
    ],
    [
      "with a sudo rule",
      () => {
        // A logging shim, as the others are.
        writeFileSync(
          join(root, "bin", "sudo"),
          `#!/usr/bin/env bash\nprintf '%s' sudo >> "$T/log"; printf ' %q' "$@" >> "$T/log"; echo >> "$T/log"\necho "User may run the following commands: (ALL) ALL"\n`,
        );
        chmodSync(join(root, "bin", "sudo"), 0o755);
      },
    ],
  ];
  for (const [name, setup] of rootWays)
    it(`takes a user that can become root (${name}) and tells go-on`, () => {
      setup();
      const result = adopt();
      expect(result.code).toBe(0);
      expectPersonUntouched();
      expect(sent("go-on")).toEqual({
        member: USER_ID,
        osUser: PERSON,
        uid: PERSON_UID,
        adopted: true,
        rootCapable: true,
      });
      // The root check still ran, before go-on.
      expect(at("sudo -n -l -U")).toBeGreaterThan(-1);
      expect(at("sudo -n -l -U")).toBeLessThan(goOnAt());
    });

  describe("disable", () => {
    // A finished adopt, then the office's record of it.
    function adopted(lingered: boolean): void {
      if (lingered) lingers();
      expect(adopt().code).toBe(0);
      expect(existsSync(mark())).toBe(true);
      memberInfo({ name: PERSON, uid: PERSON_UID });
      fresh();
    }

    for (const lingered of [false, true])
      it(`removes only Isomux's parts and puts the linger back ${lingered ? "on" : "off"}`, () => {
        adopted(lingered);
        const result = run("disable", "Alice");
        expect(result.code).toBe(0);
        expect(sent("disable")).toEqual({ member: USER_ID });
        expect(log()).toContain(`systemctl disable --now ${PERSON_UNIT}`);
        expectPersonUntouched();
        expectNoIsomuxParts();
        expect(called("atrm")).toBe(false);
        expect(log().includes(`loginctl disable-linger ${PERSON}`)).toBe(
          !lingered,
        );
      });

    // The mark is the only thing on the box that says the user is a
    // person's own. When it is gone (a wiped /etc/isomux, a restore), disable
    // must still never end, lock or delete the user: only a user with this
    // member's .made mark gets those steps.
    it("never ends, locks or deletes the user when the mark is gone", () => {
      adopted(false);
      rmSync(mark());
      const result = run("disable", "Alice");
      expect(sent("disable")).toEqual({ member: USER_ID });
      expect(log()).toContain(`systemctl disable --now ${PERSON_UNIT}`);
      expect(result.code).toBe(0);
      expectPersonUntouched();
      expect(called("atrm")).toBe(false);
      expect(existsSync(personShare())).toBe(false);
      expect(existsSync(etc(`${PERSON}.env`))).toBe(false);
    });

    it("refuses --delete-user before any change", () => {
      adopted(false);
      const result = run("disable", "Alice", "--delete-user");
      expect(result.code).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(sent("disable")).toBeNull();
      for (const change of ["systemctl", "loginctl", "userdel", "usermod"])
        expect([change, called(change)]).toEqual([change, false]);
      expectPersonUntouched();
      expect(existsSync(personShare())).toBe(true);
      expect(existsSync(mark())).toBe(true);
    });
  });

  // Task 12c796b2: a person's user that another member's enable adopted.
  // The next member joins it as adopted, whatever the flag: the mark, the
  // linger, the share and the unit are the first member's, and stay.
  describe("that other members run as", () => {
    function adoptedForOther(onUser: string[], osUser: object | null): void {
      writeFileSync(mark(), "u-first\nlinger=0\n");
      mkdirSync(personShare(), { recursive: true });
      chmodSync(join(root, "share"), 0o755);
      chmodSync(personShare(), 0o2750);
      writeFileSync(etc(`${PERSON}.env`), "ISOMUX_OFFICE_UID=1000\n");
      answer("info", 200, {
        ok: true,
        userId: USER_ID,
        role: "member",
        userName: OS_USER,
        osUser,
        state: osUser ? "isolated" : "none",
        onUser,
      });
    }
    function expectAdoptKept(): void {
      expectPersonUntouched();
      expect(readFileSync(mark(), "utf8")).toBe("u-first\nlinger=0\n");
      expect(existsSync(personShare())).toBe(true);
      expect(existsSync(etc(`${PERSON}.env`))).toBe(true);
      for (const step of ["systemctl disable", "loginctl disable-linger"])
        expect([step, called(step)]).toEqual([step, false]);
    }

    for (const flag of ["--existing-user", "--user"])
      it(`joins it with ${flag}, and tells go-on the user is adopted`, () => {
        adoptedForOther(["Bob"], null);
        const result = run("enable", "Alice", flag, PERSON);
        expect(result.code).toBe(0);
        expect(sent("go-on")).toEqual({
          member: USER_ID,
          osUser: PERSON,
          uid: PERSON_UID,
          adopted: true,
        });
        expectAdoptKept();
      });

    it("undoes nothing when the office refuses the join's go-on", () => {
      adoptedForOther(["Bob"], null);
      answer("go-on", 200, {
        ok: false,
        ready: false,
        reason: "the runner did not connect",
      });
      const result = adopt();
      expect(result.code).toBe(1);
      expect(sent("go-on")).not.toBeNull();
      expectAdoptKept();
    });

    it("disable of one of them changes nothing on the user", () => {
      adoptedForOther(["Bob"], { name: PERSON, uid: PERSON_UID });
      answer("disable", 200, { ok: true, userStays: true });
      const result = run("disable", "Alice");
      expect(result.code).toBe(0);
      expect(sent("disable")).toEqual({ member: USER_ID });
      expectAdoptKept();
      expect(called("systemctl")).toBe(false);
    });
  });

  describe("an adopt that go-on did not finish", () => {
    function cut(): void {
      rmSync(join(root, "answers", "go-on"));
      expect(adopt().code).toBe(1);
      expect(sent("go-on")).not.toBeNull();
      // Kept for the rerun: the office may hold the record.
      expect(existsSync(mark())).toBe(true);
      expect(existsSync(personShare())).toBe(true);
      expect(called("systemctl disable")).toBe(false);
      expect(called("loginctl disable-linger")).toBe(false);
      expectPersonUntouched();
      answer("go-on", 200, { ok: true, ready: true });
      memberInfo({ name: PERSON, uid: PERSON_UID });
      fresh();
    }

    for (const extra of [[], ["--existing-user", PERSON]])
      it(`finishes on a rerun of enable${extra.length ? " --existing-user" : ""}, and tells go-on the user is adopted`, () => {
        cut();
        const result = run("enable", "Alice", ...extra);
        expect(result.code).toBe(0);
        expectPersonUntouched();
        const body = { member: USER_ID, osUser: PERSON, uid: PERSON_UID };
        expect(sent("prepare")).toEqual(body);
        expect(sent("go-on")).toEqual({ ...body, adopted: true });
        for (const step of [
          `systemctl enable --now ${PERSON_UNIT}`,
          "sudo -n -l -U",
        ])
          expect([step, at(step) >= 0 && at(step) < goOnAt()]).toEqual([
            step,
            true,
          ]);
      });

    it("finishes the rerun of a user that can become root, and tells go-on so", () => {
      cut();
      writeFileSync(join(root, "groups"), `${PERSON} sudo\n`);
      const result = run("enable", "Alice");
      expect(result.code).toBe(0);
      expect(sent("go-on")).toEqual({
        member: USER_ID,
        osUser: PERSON,
        uid: PERSON_UID,
        adopted: true,
        rootCapable: true,
      });
    });

    // Task 12c796b2: the mark names the first member on the user; any
    // member's rerun on a marked user finishes as adopted.
    it("finishes a rerun when the mark names another member, and leaves the mark as it was", () => {
      cut();
      writeFileSync(mark(), "u-another\nlinger=0\n");
      const result = run("enable", "Alice");
      expect(result.code).toBe(0);
      expect(sent("go-on")).toEqual({
        member: USER_ID,
        osUser: PERSON,
        uid: PERSON_UID,
        adopted: true,
      });
      expect(readFileSync(mark(), "utf8")).toBe("u-another\nlinger=0\n");
      expectPersonUntouched();
    });
  });
});
