// `isomux-rescue agent` (scripts/rescue-root.sh, task cdd7883d slice 5),
// driven with PATH stubs. The coding agent runs as a dedicated user with no
// rights (isomux-rescue), never as root, the service user or the person
// behind sudo: it reads what the office's members wrote.
//
// Stubs: `id` says root and answers for the isomux-rescue account from
// files the test seeds (or `useradd` writes). `runuser` runs its command as
// this user and exports RUNUSER_AS=<user>; with -l it gives the command the
// account's login PATH, which alone holds the fake CLIs. The wrapper's own
// PATH holds a decoy `claude` that must never run. `tar` logs who ran it and
// passes through to the real tar, or, for the attacker case, writes a crafted
// archive in place of the service user's export. `docker` runs the command of
// a `compose exec` here, with the container's /tmp mapped to a test folder.
// The wrapper needs a terminal on stdin, so each run goes through script(1).

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { INSTRUCTION_FILE_NAMES, agentBrief } from "./rescue.ts";

setDefaultTimeout(30_000);

const REPO = join(import.meta.dir, "..");
const WRAPPER = join(import.meta.dir, "rescue-root.sh");
const SERVICE = "isomux-t-rescue-agent";
const AGENT_USER = "isomux-rescue";
const SYSTEM_UID = 998;
// A line only the journal stub prints: it must reach report.md and never
// root's terminal.
const JOURNAL_LINE = "journal-line-for-the-agent-report";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function stub(binDir: string, name: string, body: string): void {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

interface Account {
  uid: number;
  home: string;
  groups: string;
}

interface Rig {
  dir: string;
  stateRoot: string;
  agentHome: string;
  log: string;
  /** The container's /tmp. */
  ctmp: string;
  run(
    args: string[],
    opts?: { tty?: boolean },
  ): Promise<{ code: number; out: string }>;
  lines(prefix: string): string[];
  /** The calls the fake CLIs and the decoy recorded. */
  cli(): {
    who: string;
    as: string;
    pty: boolean;
    cwd: string;
    args: string[];
  }[];
  /** The `tar -c` sources: the export dirs the service user streamed. */
  exportDirs(): string[];
}

function rig(
  opts: {
    container?: boolean;
    /** The fake CLIs on the account's login PATH. */
    clis?: string[];
    cliExit?: number;
    /** A tar archive the service user's `tar -c` writes in place of the export. */
    crafted?: string;
    /** `tar -x` fails. */
    extractFails?: boolean;
  } = {},
): Rig {
  dir = mkdtempSync(join(tmpdir(), "rescue-agent-test-"));
  const bin = join(dir, "bin");
  const loginBin = join(dir, "login-bin");
  const stateRoot = join(dir, "home", ".isomux");
  const agentHome = join(dir, "agent-home");
  const containerDir = join(dir, "container");
  const ctmp = join(dir, "ctmp");
  const acct = join(dir, "account");
  const log = join(dir, "calls.log");
  const conf = join(dir, "update.conf");
  for (const d of [bin, loginBin, stateRoot, containerDir, ctmp, acct])
    mkdirSync(d, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(join(dir, "unit"), "active enabled\n");
  // Content for the export, with instruction files in it.
  mkdirSync(join(stateRoot, "memory"), { recursive: true });
  writeFileSync(join(stateRoot, "memory", "office.md"), "kept-memory-line");
  mkdirSync(join(stateRoot, "skills", "s1"), { recursive: true });
  writeFileSync(join(stateRoot, "skills", "s1", "CLAUDE.md"), "injected-1");
  const me = userInfo();
  writeFileSync(
    conf,
    [
      `DEPLOYMENT_KIND=${opts.container ? "container" : "git"}`,
      "REPO_DIR=" + join(dir, "repo"),
      "SERVICE_NAME=" + SERVICE,
      "SERVICE_KIND=system",
      "SERVICE_USER=" + me.username,
      "STATE_ROOT=" + stateRoot,
      "BUN=" + process.execPath,
      "BASE_URL=http://127.0.0.1:1",
      "",
    ].join("\n"),
  );
  // The checkout root runs as the service user, with a brief an attacker
  // rewrote: the wrapper must not read it.
  mkdirSync(join(dir, "repo", "scripts"), { recursive: true });
  for (const name of ["rescue.ts"])
    symlinkSync(
      join(REPO, "scripts", name),
      join(dir, "repo", "scripts", name),
    );
  writeFileSync(
    join(dir, "repo", "scripts", "rescue-agent.md"),
    "TAMPERED-BRIEF RESCUE_COMMAND\n",
  );

  stub(
    bin,
    "id",
    `if [[ $# -eq 1 && "$1" == -u ]]; then echo 0; exit 0; fi
user="\${@: -1}"
if [[ $user == ${AGENT_USER} ]]; then
  [[ -e ${acct}/uid ]] || { echo "id: '$user': no such user" >&2; exit 1; }
  uid=$(<${acct}/uid); groups=$(<${acct}/groups)
  case "\${*:1:$#-1}" in
    -u|-g|-ru|-rg) echo "$uid" ;;
    -nG|-Gn|"-n -G"|"-G -n") echo "$groups" ;;
    -G) n=0; out=""; for g in $groups; do out+="$((uid + n)) "; n=$((n + 1)); done; echo "\${out% }" ;;
    -un|-nu) echo ${AGENT_USER} ;;
    "") echo "uid=$uid(${AGENT_USER}) gid=$uid(${AGENT_USER}) groups=$uid(${AGENT_USER})" ;;
    *) echo "id stub: unknown $*" >&2; exit 125 ;;
  esac
  exit 0
fi
exec /usr/bin/id "$@"`,
  );
  stub(
    bin,
    "getent",
    `case "$1 $2" in
  "passwd ${AGENT_USER}")
    [[ -e ${acct}/uid ]] || exit 2
    echo "${AGENT_USER}:x:$(<${acct}/uid):$(<${acct}/uid)::$(<${acct}/home):/bin/bash" ;;
  "passwd ${me.username}") echo "${me.username}:x:${me.uid}:${me.gid}::${join(dir, "home")}:/bin/bash" ;;
  "group ${AGENT_USER}")
    [[ -e ${acct}/uid ]] || exit 2
    echo "${AGENT_USER}:x:$(<${acct}/uid):" ;;
  *) exit 2 ;;
esac`,
  );
  // --create-home with Ubuntu's HOME_MODE 0750.
  stub(
    bin,
    "useradd",
    `echo "useradd $*" >> ${log}
home=""; prev=""
for a in "$@"; do
  case $prev in -d|--home-dir) home=$a ;; esac
  case $a in --home-dir=*) home=\${a#*=} ;; esac
  prev=$a
done
[[ -n $home ]] || home=/home/${AGENT_USER}
mkdir -p "$home"; chmod 750 "$home"
echo ${SYSTEM_UID} > ${acct}/uid; echo "$home" > ${acct}/home; echo ${AGENT_USER} > ${acct}/groups`,
  );
  for (const name of ["usermod", "groupadd", "adduser", "passwd", "chsh"])
    stub(bin, name, `echo "${name} $*" >> ${log}; exit 1`);
  // runuser [-P|--pty] [-l|-] [-u user] [user] [-c cmd] [--] [cmd...]
  stub(
    bin,
    "runuser",
    `echo "runuser $*" >> ${log}
user=""; login=0; cmd=""; hascmd=0; pty=0
while (($#)); do
  case $1 in
    -u|--user) user=$2; shift 2 ;;
    -l|--login|-) login=1; shift ;;
    -P|--pty) pty=1; shift ;;
    -c|--command) cmd=$2; hascmd=1; shift 2 ;;
    --command=*) cmd=\${1#*=}; hascmd=1; shift ;;
    -m|-p|--preserve-environment) shift ;;
    -s|--shell|-g|--group|-G|--supp-group|-w|--whitelist-environment) shift 2 ;;
    --) shift; break ;;
    -*) echo "runuser stub: unknown $1" >&2; exit 125 ;;
    *) if [[ -z $user ]]; then user=$1; shift; else break; fi ;;
  esac
done
[[ -n $user ]] || user=root
export RUNUSER_AS=$user RUNUSER_PTY=$pty
if [[ $user == ${AGENT_USER} ]]; then
  [[ -e ${acct}/home ]] || { echo "runuser: user ${AGENT_USER} does not exist" >&2; exit 1; }
  home=$(<${acct}/home)
else home=${join(dir, "home")}; fi
if ((login)); then
  # The login shell runs the account's own profile: record whether it could
  # reach root's terminal (a controlling tty, or a tty on fd 0-2).
  ctty=0; ( exec 3</dev/tty ) 2>/dev/null && ctty=1
  ttyfd=0; { [[ -t 0 ]] || [[ -t 1 ]] || [[ -t 2 ]]; } && ttyfd=1
  echo "pty=$pty ctty=$ctty ttyfd=$ttyfd" >> ${join(dir, "logins")}
  cd "$home" || exit 1
  if ((hascmd)); then exec env -i HOME="$home" PATH="${loginBin}:/usr/bin:/bin" RUNUSER_AS="$user" RUNUSER_PTY="$pty" TERM="\${TERM:-dumb}" bash -c "$cmd"; fi
  exec env -i HOME="$home" PATH="${loginBin}:/usr/bin:/bin" RUNUSER_AS="$user" RUNUSER_PTY="$pty" "$@"
fi
if ((hascmd)); then exec bash -c "$cmd"; fi
exec "$@"`,
  );
  const crafted = opts.crafted ?? "";
  stub(
    bin,
    "tar",
    `echo "tar as=\${RUNUSER_AS:-root} $*" >> ${log}
mode=""; src=""; prev=""
for a in "$@"; do
  [[ $prev == -C ]] && src=$a
  case $a in --create) mode=c ;; --extract|--get) mode=x ;; --*) ;; -*c*) mode=c ;; -*x*) mode=x ;; esac
  case $a in --directory=*) src=\${a#*=} ;; esac
  prev=$a
done
if [[ $mode == c ]]; then
  :
  echo "$src" >> ${join(dir, "export-dirs")}
  ${crafted ? `cat ${crafted}; exit 0` : ""}
fi
if [[ $mode == x ]]; then
  :
  ${opts.extractFails ? "cat >/dev/null; exit 2" : ""}
fi
exec /usr/bin/tar "$@"`,
  );
  stub(bin, "bun", `exec ${process.execPath} "$@"`);
  stub(
    bin,
    "systemctl",
    `read -r state enabled < ${join(dir, "unit")}
for a in "$@"; do case $a in
  is-active) echo "$state"; [[ $state == active ]]; exit ;;
  is-enabled) echo "$enabled"; [[ $enabled == enabled ]]; exit ;;
  show) echo 987654321; exit 0 ;;
esac; done
echo "systemctl $*" >> ${log}`,
  );
  stub(bin, "curl", `echo ok`);
  stub(bin, "journalctl", `echo "${JOURNAL_LINE}"`);
  // docker compose [--env-file f] exec [-T] [-u u] [-e K=V]... office cmd...
  stub(
    bin,
    "docker",
    `echo "docker $*" >> ${log}
[[ $1 == compose ]] || exit 125; shift
args=()
while (($#)); do
  case $1 in
    --env-file|-f|-p) shift 2 ;;
    exec) shift; break ;;
    *) echo "docker stub: no $1" >&2; exit 125 ;;
  esac
done
while (($#)); do
  case $1 in
    -T|-i|-t) shift ;;
    -u|--user|-e|--env|-w|--workdir) shift 2 ;;
    office) shift; break ;;
    *) echo "docker stub: unknown $1" >&2; exit 125 ;;
  esac
done
for a in "$@"; do args+=("\${a//\\/tmp\\//${ctmp}/}"); done
export RUNUSER_AS=container HOME=${join(dir, "home")} ISOMUX_HOME=${stateRoot}
cd ${REPO} && exec "\${args[@]}"`,
  );
  // The decoy on root's PATH, and the real fakes on the login PATH.
  const cliBody = (who: string, exit: number) =>
    `printf '%s\\t%s\\t%s\\t%s' "${who}" "\${RUNUSER_AS:-root}" "\${RUNUSER_PTY:-0}" "$PWD" >> ${join(dir, "cli.log")}
for a in "$@"; do printf '\\t%s' "$a" >> ${join(dir, "cli.log")}; done
echo >> ${join(dir, "cli.log")}
# What the folder and the export dirs held at the start.
find . -mindepth 1 | sort > ${join(dir, "cli-files")}
: > ${join(dir, "cli-export-dirs-left")}
if [[ -e ${join(dir, "export-dirs")} ]]; then
  while IFS= read -r d; do [[ -n $d && -e $d ]] && echo "$d" >> ${join(dir, "cli-export-dirs-left")}; done < ${join(dir, "export-dirs")}
fi
exit ${exit}`;
  stub(bin, "claude", cliBody("root-decoy", 99));
  stub(bin, "codex", cliBody("root-decoy", 99));
  for (const name of opts.clis ?? ["claude"])
    stub(loginBin, name, cliBody(name, opts.cliExit ?? 0));

  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: join(dir, "root-home"),
    TERM: "xterm",
    ISOMUX_RESCUE_CONF: conf,
    ISOMUX_RESCUE_ROOT_MARKER_DIR: join(dir, "etc"),
    ISOMUX_RESCUE_PROC: join(dir, "proc"),
    ISOMUX_RESCUE_AGENT_HOME: agentHome,
    ISOMUX_RESCUE_CONTAINER_DIR: containerDir,
  };
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return {
    dir,
    stateRoot,
    agentHome,
    log,
    ctmp,
    run: async (args, runOpts = {}) => {
      const line = ["bash", WRAPPER, ...args].map(quote).join(" ");
      const argv =
        runOpts.tty === false
          ? ["bash", WRAPPER, ...args]
          : ["script", "-qec", line, "/dev/null"];
      const p = Bun.spawn(argv, {
        cwd: dir,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, out: (out + err).replace(/\r/g, "") };
    },
    lines: (prefix) =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith(prefix)),
    cli: () => {
      const path = join(dir, "cli.log");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [who, as, pty, cwd, ...args] = l.split("\t");
          return { who, as, pty: pty === "1", cwd, args };
        });
    },
    exportDirs: () => {
      const path = join(dir, "export-dirs");
      return existsSync(path)
        ? readFileSync(path, "utf8").split("\n").filter(Boolean)
        : [];
    },
  };
}

const ourAccount = (r: Rig): Account => ({
  uid: SYSTEM_UID,
  home: r.agentHome,
  groups: AGENT_USER,
});

/** An isomux-rescue account that exists before the run. */
function seedAccount(r: Rig, account: Account): void {
  writeFileSync(join(r.dir, "account", "uid"), String(account.uid));
  writeFileSync(join(r.dir, "account", "home"), account.home);
  writeFileSync(join(r.dir, "account", "groups"), account.groups);
  mkdirSync(account.home, { recursive: true });
  // The expected home exists too, so a refusal is not just a failed mkdir.
  mkdirSync(r.agentHome, { recursive: true });
}

const isInstructionName = (path: string) =>
  INSTRUCTION_FILE_NAMES.includes(path.split("/").pop()!.toLowerCase());

/** The one folder the run made in the agent's home. */
function madeFolder(r: Rig): string | null {
  if (!existsSync(r.agentHome)) return null;
  const made = readdirSync(r.agentHome).filter((n) =>
    n.startsWith("isomux-rescue-"),
  );
  return made.length === 1 ? join(r.agentHome, made[0]) : null;
}

const fileText = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8") : null;
const fileMode = (path: string) =>
  existsSync(path) ? statSync(path).mode & 0o777 : null;

describe("agent as root", () => {
  test("first run: makes the isomux-rescue account, fills a new folder with the export, the report and the wrapper's brief, and starts the CLI as that account, in a new terminal, on its login PATH", async () => {
    const r = rig({ cliExit: 7 });
    const res = await r.run(["agent"]);
    if (res.code !== 7) console.error(res.out);
    const folder = madeFolder(r) ?? "";
    const starts = r.cli();
    const brief = agentBrief(
      readFileSync(join(import.meta.dir, "rescue-agent.md"), "utf8"),
      "sudo isomux-rescue",
    );
    const files = existsSync(join(r.dir, "cli-files"))
      ? readFileSync(join(r.dir, "cli-files"), "utf8")
          .split("\n")
          .filter(Boolean)
      : [];
    expect({
      code: res.code,
      useradd: r.lines("useradd ").length,
      // A system account with its own home and no extra group.
      useraddArgs: r.lines("useradd ").map((l) => ({
        system: / (--system|-r)( |$)/.test(l),
        home: l.includes(r.agentHome),
        groups: / (-G|--groups)( |=)/.test(l),
      })),
      folderMade: folder !== "",
      folderMode: fileMode(folder),
      // The CLI that ran is the account's, as the account, in the folder.
      // Its own terminal (runuser --pty), never root's.
      starts: starts.map((s) => ({
        who: s.who,
        as: s.as,
        pty: s.pty,
        cwd: s.cwd,
        args: s.args.length,
      })),
      prompt: starts[0]?.args[0]?.includes("report.md"),
      // Everything was in place at the start, and the export temp was gone.
      atStart: {
        readme: files.includes("./office/README.md"),
        memory: files.includes("./office/memory/office.md"),
        report: files.includes("./report.md"),
        agents: files.includes("./AGENTS.md"),
        claude: files.includes("./CLAUDE.md"),
        instructionNames: files.filter(
          (f) => f.startsWith("./office/") && isInstructionName(f),
        ),
        exportLeft: fileText(join(r.dir, "cli-export-dirs-left")),
      },
      agentsMd: fileText(join(folder, "AGENTS.md")),
      claudeMd: fileText(join(folder, "CLAUDE.md")),
      modes: ["report.md", "AGENTS.md", "CLAUDE.md"].map((f) =>
        fileMode(join(folder, f)),
      ),
      renamed: fileText(join(folder, "office", "skills", "s1", "_CLAUDE.md")),
      reportHasJournal: fileText(join(folder, "report.md"))?.includes(
        JOURNAL_LINE,
      ),
      // The report is not echoed to root's terminal; the closing line names
      // the folder to delete.
      echoed: res.out.includes(JOURNAL_LINE),
      closing: res.out.includes(folder),
    }).toEqual({
      code: 7,
      useradd: 1,
      useraddArgs: [{ system: true, home: true, groups: false }],
      folderMade: true,
      folderMode: 0o700,
      starts: [
        { who: "claude", as: AGENT_USER, pty: true, cwd: folder, args: 1 },
      ],
      prompt: true,
      atStart: {
        readme: true,
        memory: true,
        report: true,
        agents: true,
        claude: true,
        instructionNames: [],
        exportLeft: "",
      },
      agentsMd: brief,
      claudeMd: brief,
      modes: [0o600, 0o600, 0o600],
      renamed: "injected-1",
      reportHasJournal: true,
      echoed: false,
      closing: true,
    });
  });

  test("root extracts nothing and starts nothing: every extract runs as isomux-rescue and every archive is written by the service user", async () => {
    const r = rig();
    const res = await r.run(["agent"]);
    if (res.code !== 0) console.error(res.out);
    const tars = r.lines("tar ");
    const extracts = tars.filter((l) =>
      / (-[a-zA-Z]*x[a-zA-Z]*|--extract)( |$)/.test(l),
    );
    const creates = tars.filter((l) =>
      / (-[a-zA-Z]*c[a-zA-Z]*|--create)( |$)/.test(l),
    );
    expect({
      code: res.code,
      extracts: extracts.length > 0,
      extractAs: [...new Set(extracts.map((l) => l.split(" ")[1]))],
      creates: creates.length > 0,
      createAs: [...new Set(creates.map((l) => l.split(" ")[1]))],
      cliAs: r.cli().map((s) => s.as),
    }).toEqual({
      code: 0,
      extracts: true,
      extractAs: [`as=${AGENT_USER}`],
      creates: true,
      createAs: [`as=${userInfo().username}`],
      cliAs: [AGENT_USER],
    });
  });

  // The account's profile is code the account controls: a tricked agent
  // from an earlier run can write it. Every login shell gets its own pty
  // (runuser --pty) or no terminal at all, never root's (TIOCSTI).
  test("no login shell of the account gets root's terminal: the CLI lookup included", async () => {
    const r = rig();
    const res = await r.run(["agent"]);
    if (res.code !== 0) console.error(res.out);
    const logins = existsSync(join(r.dir, "logins"))
      ? readFileSync(join(r.dir, "logins"), "utf8").split("\n").filter(Boolean)
      : [];
    // The enabling condition: the wrapper itself had root's terminal.
    const rootTty = res.code === 0 && logins.length >= 2;
    expect({
      rootTty,
      onRootTerminal: logins.filter(
        (l) => l.includes("pty=0") && !l.includes("ctty=0 ttyfd=0"),
      ),
    }).toEqual({ rootTty: true, onRootTerminal: [] });
  });

  test("a second run uses the account the first one made, without useradd", async () => {
    const r = rig();
    const first = await r.run(["agent"]);
    // A folder named: the default one is stamped to the second.
    const second = await r.run(["agent", join(r.agentHome, "second")]);
    expect({
      codes: [first.code, second.code],
      useradd: r.lines("useradd ").length,
      starts: r.cli().map((s) => s.as),
    }).toEqual({ codes: [0, 0], useradd: 1, starts: [AGENT_USER, AGENT_USER] });
  });

  test("an isomux-rescue account it did not make is refused: another home, a user uid, or any group besides its own", async () => {
    const cases: ((r: Rig) => Account)[] = [
      (r) => ({
        uid: SYSTEM_UID,
        home: r.agentHome,
        groups: `${AGENT_USER} docker`,
      }),
      (r) => ({
        uid: SYSTEM_UID,
        home: r.agentHome,
        groups: `${AGENT_USER} sudo`,
      }),
      (r) => ({
        uid: SYSTEM_UID,
        home: join(r.dir, "elsewhere"),
        groups: AGENT_USER,
      }),
      (r) => ({ uid: 1500, home: r.agentHome, groups: AGENT_USER }),
      // The control: our own account.
      ourAccount,
    ];
    const results: {
      code: number;
      useradd: number;
      starts: number;
      folders: number;
    }[] = [];
    for (const make of cases) {
      const r = rig();
      seedAccount(r, make(r));
      const res = await r.run(["agent"]);
      results.push({
        code: res.code,
        useradd: r.lines("useradd ").length,
        starts: r.cli().length,
        folders: existsSync(r.agentHome)
          ? readdirSync(r.agentHome).filter((n) =>
              n.startsWith("isomux-rescue-"),
            ).length
          : 0,
      });
      rmSync(r.dir, { recursive: true, force: true });
    }
    expect(results).toEqual([
      ...cases
        .slice(0, -1)
        .map(() => ({ code: 1, useradd: 0, starts: 0, folders: 0 })),
      { code: 0, useradd: 0, starts: 1, folders: 1 },
    ]);
  });

  test("the CLI comes from the account's login PATH, never root's: codex when only codex is there, --cli picks, and none there exits 1 naming the account", async () => {
    const out: { code: number; who: string[] }[] = [];
    const runs: { clis: string[]; args: string[] }[] = [
      { clis: ["codex"], args: [] },
      { clis: ["claude", "codex"], args: ["--cli", "codex"] },
      { clis: ["codex"], args: ["--cli", "claude"] },
      { clis: [], args: [] },
    ];
    let lastOut = "";
    for (const run of runs) {
      const r = rig({ clis: run.clis });
      const res = await r.run(["agent", ...run.args]);
      out.push({ code: res.code, who: r.cli().map((s) => s.who) });
      lastOut = res.out;
      rmSync(r.dir, { recursive: true, force: true });
    }
    expect({ out, namesAccount: lastOut.includes(AGENT_USER) }).toEqual({
      out: [
        { code: 0, who: ["codex"] },
        { code: 0, who: ["codex"] },
        { code: 1, who: [] },
        { code: 1, who: [] },
      ],
      namesAccount: true,
    });
  });

  test("refuses without a terminal, and refuses a folder that exists; neither makes an account, a folder or a start", async () => {
    const r = rig();
    const noTty = await r.run(["agent"], { tty: false });
    const given = join(r.dir, "given");
    mkdirSync(given);
    writeFileSync(join(given, "keep.txt"), "mine");
    const exists = await r.run(["agent", given]);
    const refused = {
      codes: [noTty.code, exists.code],
      starts: r.cli().length,
      given: readdirSync(given),
      folders: existsSync(r.agentHome)
        ? readdirSync(r.agentHome).filter((n) => n.startsWith("isomux-rescue-"))
            .length
        : 0,
      exports: r.exportDirs().length,
    };
    // The control: the same rig with a terminal and a new folder starts.
    const fresh = await r.run(["agent", join(r.dir, "fresh")]);
    expect({
      refused,
      control: { code: fresh.code, starts: r.cli().length },
    }).toEqual({
      refused: {
        codes: [1, 1],
        starts: 0,
        given: ["keep.txt"],
        folders: 0,
        exports: 0,
      },
      control: { code: 0, starts: 1 },
    });
  });

  test("a folder given is made 0700 by the account, outside its home too", async () => {
    const r = rig();
    const given = join(r.dir, "outside", "rescue-here");
    mkdirSync(join(r.dir, "outside"));
    const res = await r.run(["agent", given]);
    if (res.code !== 0) console.error(res.out);
    expect({
      code: res.code,
      mode: fileMode(given),
      cwd: r.cli()[0]?.cwd,
      madeBy: r
        .lines("runuser ")
        .some(
          (l) =>
            l.includes(AGENT_USER) && l.includes("mkdir") && l.includes(given),
        ),
      officeFileMode: fileMode(join(given, "office", "memory", "office.md")),
    }).toEqual({
      code: 0,
      mode: 0o700,
      cwd: given,
      madeBy: true,
      officeFileMode: 0o600,
    });
  });

  // The service user writes the archive, and it may be the attacker.
  test("an archive from the service user keeps only regular files and directories, private, with instruction files renamed", async () => {
    const base = mkdtempSync(join(tmpdir(), "rescue-agent-craft-"));
    try {
      const src = join(base, "src");
      mkdirSync(join(src, "notes"), { recursive: true });
      writeFileSync(join(src, "plain.txt"), "plain");
      writeFileSync(join(src, "CLAUDE.md"), "INJECTED-ROOT");
      writeFileSync(join(src, "notes", "AGENTS.MD"), "INJECTED-NOTES");
      symlinkSync("/etc/passwd", join(src, "link-out"));
      writeFileSync(join(src, "a.txt"), "hard");
      linkSync(join(src, "a.txt"), join(src, "b.txt"));
      for (const f of ["plain.txt", "CLAUDE.md", "notes/AGENTS.MD", "a.txt"])
        chmodSync(join(src, f), 0o644);
      chmodSync(join(src, "notes"), 0o755);
      const crafted = join(base, "crafted.tar");
      const made = Bun.spawnSync(["tar", "-C", src, "-cf", crafted, "."]);
      expect(made.exitCode).toBe(0);
      const r = rig({ crafted });
      const res = await r.run(["agent"]);
      if (res.code !== 0) console.error(res.out);
      const office = join(madeFolder(r) ?? "/nonexistent", "office");
      const all = existsSync(office)
        ? (readdirSync(office, { recursive: true }) as string[]).sort()
        : [];
      const kinds = all.map((p) => {
        const st = lstatSync(join(office, p));
        return {
          p,
          kind: st.isSymbolicLink()
            ? "link"
            : st.isDirectory()
              ? "dir"
              : st.isFile()
                ? "file"
                : "other",
          links: st.nlink,
          mode: st.mode & 0o777,
        };
      });
      expect({
        code: res.code,
        plain: fileText(join(office, "plain.txt")),
        notRegular: kinds
          .filter((k) => k.kind !== "file" && k.kind !== "dir")
          .map((k) => k.p),
        hardLinked: kinds
          .filter((k) => k.kind === "file" && k.links > 1)
          .map((k) => k.p),
        instructionNames: all.filter(isInstructionName),
        renamed: [
          fileText(join(office, "_CLAUDE.md")),
          fileText(join(office, "notes", "_AGENTS.MD")),
        ],
        open: kinds.filter((k) => (k.mode & 0o077) !== 0).map((k) => k.p),
        starts: r.cli().length,
      }).toEqual({
        code: 0,
        plain: "plain",
        notRegular: [],
        hardLinked: [],
        instructionNames: [],
        renamed: ["INJECTED-ROOT", "INJECTED-NOTES"],
        open: [],
        starts: 1,
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a failed extract starts nothing and leaves no export behind", async () => {
    const r = rig({ extractFails: true });
    const res = await r.run(["agent"]);
    const left = r.exportDirs().filter((d) => existsSync(d));
    expect({
      failed: res.code !== 0,
      exported: r.exportDirs().length > 0,
      left,
      starts: r.cli().length,
    }).toEqual({ failed: true, exported: true, left: [], starts: 0 });
  });
});

describe("agent as root, container", () => {
  test("streams the export and the report out of the container to the account, removes the container's copy, and starts the CLI", async () => {
    const r = rig({ container: true, cliExit: 3 });
    const res = await r.run(["agent"]);
    if (res.code !== 3) console.error(res.out);
    const folder = madeFolder(r) ?? "/nonexistent";
    const tars = r.lines("tar ");
    expect({
      code: res.code,
      memory: fileText(join(folder, "office", "memory", "office.md")),
      renamed: fileText(join(folder, "office", "skills", "s1", "_CLAUDE.md")),
      reportHasJournal: fileText(join(folder, "report.md"))?.includes(
        JOURNAL_LINE,
      ),
      // The archive came out of the container, and the account unpacked it.
      createAs: [
        ...new Set(
          tars
            .filter((l) => / (-[a-zA-Z]*c[a-zA-Z]*|--create)( |$)/.test(l))
            .map((l) => l.split(" ")[1]),
        ),
      ],
      extractAs: [
        ...new Set(
          tars
            .filter((l) => / (-[a-zA-Z]*x[a-zA-Z]*|--extract)( |$)/.test(l))
            .map((l) => l.split(" ")[1]),
        ),
      ],
      dockerCp: r.lines("docker ").filter((l) => / cp /.test(l)).length,
      containerTmpLeft: readdirSync(r.ctmp),
      starts: r
        .cli()
        .map((s) => ({ who: s.who, as: s.as, pty: s.pty, cwd: s.cwd })),
    }).toEqual({
      code: 3,
      memory: "kept-memory-line",
      renamed: "injected-1",
      reportHasJournal: true,
      createAs: ["as=container"],
      extractAs: [`as=${AGENT_USER}`],
      dockerCp: 0,
      containerTmpLeft: [],
      starts: [{ who: "claude", as: AGENT_USER, pty: true, cwd: folder }],
    });
  });
});
