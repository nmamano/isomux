// The rescue host command (task cdd7883d): see the office's state, lock it
// down and get it back when it is down or under attack. It reads the state
// root directly and needs no running office and no model.
//
//   bun run rescue status                       exit 0 healthy, 1 down, 2 locked
//   bun run rescue lockdown [--stop] [--reason <text>]
//   bun run rescue unlock
//   bun run rescue restart
//
// Self-hosted user-unit installs run it as the office's own user, and it does
// every step itself. Root installs run the root-owned wrapper
// /usr/local/sbin/isomux-rescue (scripts/rescue-root.sh) instead: no code from
// the checkout runs as root, so the wrapper does the root steps (the root
// marker, systemctl, the kills, the journal) and runs this file as the service
// user only for the steps that write the state root:
//
//   _step state-marker --reason <text> --by <who>   write <state>/LOCKDOWN
//   _step remove-state-marker
//   _step audit lockdown|unlock [--reason <text>]   only while the unit is down
//   _step quarantine
//
// Lockdown order: marker, stop, wait inactive, audit, kill leftovers,
// quarantine, start. A cut at any point leaves the office stopped or locked.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  LOCK_MARKER_FILE,
  LOCKED_READY_BODY,
  ROOT_MARKER_DIR,
  quarantineCredentials,
  readLockState,
  removeStateMarker,
  writeStateMarker,
} from "../server/lockdown.ts";
import { RESCUE_ACTOR, recordLockAudit } from "../server/lockdown-audit.ts";
import { OFFICE_PID_ENV } from "../server/stop-reap.ts";

const UPDATE_CONF = "/etc/isomux/update.conf";
const STOP_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 2_000;

export interface RescueConfig {
  stateRoot: string;
  serviceName: string;
  serviceKind: "system" | "user";
  deploymentKind: "git" | "container";
  serviceUser: string | null;
  baseUrl: string;
  rootMarkerDir: string;
  /** The updater's status dir (installed-release, outcome), when known. */
  statusDir: string | null;
}

// KEY=VALUE lines, never sourced: a value is text, whatever it holds.
function parseConf(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return values;
}

/** /etc/isomux/update.conf when present (`readFile` returns null when not),
 *  else ISOMUX_HOME or ~/.isomux, the user unit "isomux" and port 4000. */
export function loadRescueConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string | null,
  home: string,
): RescueConfig {
  const text = readFile(env.ISOMUX_RESCUE_CONF || UPDATE_CONF);
  const conf = text === null ? null : parseConf(text);
  const get = (key: string) => conf?.get(key) || null;
  return {
    stateRoot: get("STATE_ROOT") ?? (env.ISOMUX_HOME || join(home, ".isomux")),
    serviceName: get("SERVICE_NAME") ?? "isomux",
    serviceKind: conf
      ? get("SERVICE_KIND") === "user"
        ? "user"
        : "system"
      : "user",
    deploymentKind:
      get("DEPLOYMENT_KIND") === "container" ? "container" : "git",
    serviceUser: get("SERVICE_USER"),
    baseUrl: get("BASE_URL") ?? "http://127.0.0.1:4000",
    rootMarkerDir: env.ISOMUX_RESCUE_ROOT_MARKER_DIR || ROOT_MARKER_DIR,
    statusDir: get("STATUS_DIR"),
  };
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  /** Empty when the environment cannot be read. */
  env: Record<string, string>;
}

/** What rescue does to the host. Tests pass a fake. */
export interface RescueHost {
  systemctl(args: string[]): { code: number; stdout: string };
  journal(lines: number): string;
  readyz(baseUrl: string): Promise<{ status: number; body: string } | null>;
  processes(): ProcessInfo[];
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  selfPid: number;
  /** The text of /proc/self/cgroup. */
  selfCgroup: string;
  /** The uid of the split agent user, when split.json names one. */
  splitAgentUid: number | null;
  /** The uid that runs the office (the service user, or this user). */
  officeUid: number;
  diskFree(path: string): number | null;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface RescueOutput {
  log(line: string): void;
  err(line: string): void;
}

/** Whether this process runs inside the office unit's own cgroup, where
 *  stopping the unit would end it mid-lockdown. */
export function insideOfficeUnit(
  cgroupText: string,
  serviceName: string,
): boolean {
  const unit = `${serviceName}.service`;
  return cgroupText
    .split("\n")
    .some((line) =>
      line.split(":").slice(2).join(":").split("/").includes(unit),
    );
}

/** The office processes left after the unit stopped: they carry
 *  ISOMUX_OFFICE_PID equal to the unit's main pid and run as one of `uids`.
 *  Never `selfPid` or one of its ancestors. */
export function findLeftovers(
  procs: ProcessInfo[],
  opts: { officePid: number; uids: number[]; selfPid: number },
): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = new Set<number>();
  for (let pid = opts.selfPid; pid > 0 && !keep.has(pid); ) {
    keep.add(pid);
    pid = byPid.get(pid)?.ppid ?? 0;
  }
  return procs
    .filter(
      (p) =>
        !keep.has(p.pid) &&
        opts.uids.includes(p.uid) &&
        p.env[OFFICE_PID_ENV] === String(opts.officePid),
    )
    .map((p) => p.pid);
}

interface Args {
  positional: string[];
  stop: boolean;
  noJournal: boolean;
  reason: string;
  by: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    positional: [],
    stop: false,
    noJournal: false,
    reason: "",
    by: "host",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stop") args.stop = true;
    else if (a === "--no-journal") args.noJournal = true;
    else if (a === "--reason" && i + 1 < argv.length) args.reason = argv[++i];
    else if (a === "--by" && i + 1 < argv.length) args.by = argv[++i];
    else args.positional.push(a);
  }
  return args;
}

const USAGE = [
  "usage: bun run rescue <command>",
  "  status                             the office's state; exit 0 healthy, 1 down, 2 locked",
  "  lockdown [--stop] [--reason <text>] lock the office and revoke every sign-in and token",
  "  unlock                             remove the lock and start the office",
  "  restart                            restart the office and wait until it answers",
];

/** Runs one subcommand. Returns the exit code. */
export async function runRescue(
  argv: string[],
  config: RescueConfig,
  host: RescueHost,
  out: RescueOutput,
): Promise<number> {
  const args = parseArgs(argv);
  const [command, ...rest] = args.positional;
  const r = new Rescue(config, host, out);
  switch (command) {
    case "status":
      return await r.status(args);
    case "lockdown":
      return await r.lockdown(args);
    case "unlock":
      return await r.unlock();
    case "restart":
      return await r.restart();
    case "_step":
      return r.step(rest, args);
    default:
      for (const line of USAGE) out.err(line);
      return command === undefined || command === "help" ? 0 : 64;
  }
}

class Rescue {
  constructor(
    private config: RescueConfig,
    private host: RescueHost,
    private out: RescueOutput,
  ) {}

  private svc(...args: string[]): { code: number; stdout: string } {
    return this.host.systemctl(
      this.config.serviceKind === "user" ? ["--user", ...args] : args,
    );
  }

  private unitState(): string {
    return (
      this.svc("is-active", this.config.serviceName).stdout.trim() || "unknown"
    );
  }

  private unitEnabled(): boolean {
    return this.svc("is-enabled", this.config.serviceName).code === 0;
  }

  // ExecMainPID keeps the last main pid after the stop.
  private officePid(): number {
    const value = this.svc(
      "show",
      "-p",
      "ExecMainPID",
      "--value",
      this.config.serviceName,
    ).stdout.trim();
    const pid = Number(value.replace(/^ExecMainPID=/, ""));
    return Number.isSafeInteger(pid) ? pid : 0;
  }

  private async waitInactive(): Promise<boolean> {
    const deadline = +this.host.now() + STOP_TIMEOUT_MS;
    for (;;) {
      const state = this.unitState();
      if (state !== "active" && state !== "deactivating") return true;
      if (+this.host.now() >= deadline) return false;
      await this.host.sleep(500);
    }
  }

  private async waitReady(): Promise<{ status: number; body: string } | null> {
    const deadline = +this.host.now() + READY_TIMEOUT_MS;
    for (;;) {
      const ready = await this.host.readyz(this.config.baseUrl);
      if (ready?.status === 200) return ready;
      if (+this.host.now() >= deadline) return null;
      await this.host.sleep(1_000);
    }
  }

  // The full flows stop and start the unit themselves: a user unit only. A
  // root install runs the root wrapper; a container runs it on the host.
  private refuseFullFlow(): boolean {
    if (this.config.deploymentKind === "container") {
      this.out.err(
        "This office runs in a container: run isomux-rescue as root on the host.",
      );
      return true;
    }
    if (this.config.serviceKind === "system") {
      this.out.err(
        "This office runs as a system service: run sudo isomux-rescue instead.",
      );
      return true;
    }
    if (insideOfficeUnit(this.host.selfCgroup, this.config.serviceName)) {
      this.out.err(
        "This shell runs inside the office, and stopping the office would end it. Run it from a login shell on the office's machine.",
      );
      return true;
    }
    return false;
  }

  private async killLeftovers(): Promise<number[]> {
    const uids = [this.host.officeUid];
    if (this.host.splitAgentUid !== null) uids.push(this.host.splitAgentUid);
    const opts = {
      officePid: this.officePid(),
      uids,
      selfPid: this.host.selfPid,
    };
    if (opts.officePid <= 0) return [];
    const first = findLeftovers(this.host.processes(), opts);
    for (const pid of first) this.tryKill(pid, "SIGTERM");
    if (first.length === 0) return [];
    await this.host.sleep(KILL_GRACE_MS);
    for (const pid of findLeftovers(this.host.processes(), opts))
      this.tryKill(pid, "SIGKILL");
    return first;
  }

  private tryKill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    try {
      this.host.kill(pid, signal);
    } catch {
      // Gone already.
    }
  }

  async lockdown(args: Args): Promise<number> {
    if (this.refuseFullFlow()) return 1;
    const { stateRoot, serviceName } = this.config;
    const reason = args.reason;
    writeStateMarker(stateRoot, { reason, by: args.by, now: this.host.now() });
    this.out.log("Locked: the office will not start unlocked.");
    this.svc("stop", serviceName);
    if (!(await this.waitInactive())) {
      this.out.err(
        `The office did not stop within ${STOP_TIMEOUT_MS / 1000} s. It stays locked; run lockdown again.`,
      );
      return 1;
    }
    recordLockAudit(stateRoot, "lockdown", {
      actor: RESCUE_ACTOR,
      reason,
      now: this.host.now(),
    });
    const killed = await this.killLeftovers();
    if (killed.length > 0)
      this.out.log(`Ended ${killed.length} office process(es) left running.`);
    const moved = quarantineCredentials(stateRoot, this.host.now());
    if (moved.dir)
      this.out.log(
        "Revoked every sign-in, API token, invite and browser extension pairing.",
      );
    if (args.stop) {
      this.svc("disable", serviceName);
      this.out.log("The office is stopped and stays stopped after a reboot.");
    } else {
      this.svc("start", serviceName);
      const ready = await this.waitReady();
      this.out.log(
        ready
          ? "The office is up and shows only a locked page."
          : "The office did not answer yet. It stays locked; check it with: bun run rescue status",
      );
    }
    this.out.log(
      "Provider keys and connection tokens are kept but unused while locked. Rotate them at the provider if they may have leaked.",
    );
    this.out.log("To unlock: bun run rescue unlock");
    return 0;
  }

  async unlock(): Promise<number> {
    if (this.refuseFullFlow()) return 1;
    const { stateRoot, serviceName, rootMarkerDir } = this.config;
    const stateMarker = join(stateRoot, LOCK_MARKER_FILE);
    const others = readLockState(stateRoot, rootMarkerDir).markers.filter(
      (m) => m.path !== stateMarker,
    );
    if (others.length > 0) {
      this.out.err(
        `${others[0].path} locks this office, and only root can remove it: run sudo isomux-rescue unlock.`,
      );
      return 1;
    }
    removeStateMarker(stateRoot);
    recordLockAudit(stateRoot, "unlock", {
      actor: RESCUE_ACTOR,
      reason: "",
      now: this.host.now(),
    });
    if (!this.unitEnabled()) this.svc("enable", "--now", serviceName);
    else if (this.unitState() === "active") this.svc("restart", serviceName);
    else this.svc("start", serviceName);
    const ready = await this.waitReady();
    this.out.log(
      ready
        ? "Unlocked: the office is up."
        : "Unlocked, but the office did not answer yet: check it with bun run rescue status.",
    );
    this.out.log(
      "Every sign-in was revoked by the lock. Owners sign in again with the owner sign-in recovery (isomux.com/docs/access-and-invites).",
    );
    return ready ? 0 : 1;
  }

  async restart(): Promise<number> {
    this.svc("restart", this.config.serviceName);
    const ready = await this.waitReady();
    if (!ready) {
      this.out.err(
        `The office did not answer within ${READY_TIMEOUT_MS / 1000} s. See: bun run rescue status`,
      );
      return 1;
    }
    this.out.log(
      ready.body.trim() === LOCKED_READY_BODY.trim()
        ? "The office is up and locked."
        : "The office is up.",
    );
    return 0;
  }

  async status(args: Args): Promise<number> {
    const { stateRoot, serviceName, rootMarkerDir, statusDir } = this.config;
    const unit = this.unitState();
    const enabled = this.unitEnabled();
    const ready =
      unit === "active" ? await this.host.readyz(this.config.baseUrl) : null;
    const lock = readLockState(stateRoot, rootMarkerDir);
    const lockedBody =
      ready?.status === 200 && ready.body.trim() === LOCKED_READY_BODY.trim();
    const say = (label: string, value: string) =>
      this.out.log(`${label.padEnd(14)} ${value}`);
    say("Service", `${serviceName}: ${unit}${enabled ? "" : ", disabled"}`);
    say(
      "Ready check",
      ready
        ? `HTTP ${ready.status} ${JSON.stringify(ready.body.trim())}`
        : "no answer",
    );
    if (lock.locked)
      for (const m of lock.markers)
        say(
          "Locked",
          m.marker
            ? `by ${m.marker.by} since ${m.marker.since}${m.marker.reason ? `: ${m.marker.reason}` : ""} (${m.path})`
            : `${m.path} (unreadable: it still locks)`,
        );
    else say("Locked", "no");
    const version = statusDir
      ? readText(join(statusDir, "installed-release"))
      : null;
    say("Version", version ?? "unknown");
    const outcome = readText("/var/lib/isomux-update-public/outcome.json");
    if (outcome) say("Last update", outcome.replace(/\s+/g, " "));
    const free = this.host.diskFree(stateRoot);
    if (free !== null) say("Disk free", `${(free / 1e9).toFixed(1)} GB`);
    say("Last backup", newestBackup(stateRoot) ?? "none found");
    if (unit !== "active") {
      const uids = [this.host.officeUid];
      if (this.host.splitAgentUid !== null) uids.push(this.host.splitAgentUid);
      const officePid = this.officePid();
      const left =
        officePid > 0
          ? findLeftovers(this.host.processes(), {
              officePid,
              uids,
              selfPid: this.host.selfPid,
            })
          : [];
      say("Left running", left.length ? left.join(" ") : "none");
    }
    if (!args.noJournal) {
      this.out.log("");
      this.out.log("Last 50 log lines:");
      for (const line of this.host.journal(50).trimEnd().split("\n"))
        this.out.log(line);
    }
    if (lock.locked || lockedBody) return 2;
    if (unit !== "active" || ready?.status !== 200) return 1;
    return 0;
  }

  // The root wrapper's steps, run as the service user.
  step(rest: string[], args: Args): number {
    const { stateRoot } = this.config;
    const now = this.host.now();
    switch (rest[0]) {
      case "state-marker":
        writeStateMarker(stateRoot, { reason: args.reason, by: args.by, now });
        return 0;
      case "remove-state-marker":
        removeStateMarker(stateRoot);
        return 0;
      case "audit":
        if (rest[1] !== "lockdown" && rest[1] !== "unlock") break;
        recordLockAudit(stateRoot, rest[1], {
          actor: RESCUE_ACTOR,
          reason: args.reason,
          now,
        });
        return 0;
      case "quarantine": {
        const moved = quarantineCredentials(stateRoot, now);
        if (moved.dir) this.out.log(moved.dir);
        return 0;
      }
    }
    this.out.err(`unknown step: ${rest.join(" ")}`);
    return 64;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// The backup folder as server/backup.ts resolves it: ISOMUX_BACKUP_DIR, the
// office's setting, or the folder next to the state root.
function newestBackup(stateRoot: string): string | null {
  let dir = process.env.ISOMUX_BACKUP_DIR || null;
  if (!dir) {
    try {
      const config = JSON.parse(
        readFileSync(join(stateRoot, "office-config.json"), "utf8"),
      ) as { backupDir?: unknown };
      if (typeof config.backupDir === "string") dir = config.backupDir;
    } catch {
      // No setting: the default folder.
    }
  }
  dir ??= join(
    dirname(stateRoot),
    `${basename(stateRoot).replace(/^\./, "")}-backups`,
  );
  try {
    const files = readdirSync(dir).filter((f) =>
      /^isomux-.*\.tar\.gz$/.test(f),
    );
    if (files.length === 0) return null;
    const newest = files
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return `${join(dir, newest.f)} (${new Date(newest.t).toISOString()})`;
  } catch {
    return null;
  }
}

function readProcesses(): ProcessInfo[] {
  const procs: ProcessInfo[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
      const env: Record<string, string> = {};
      try {
        for (const entry of readFileSync(`/proc/${name}/environ`, "utf8").split(
          "\0",
        )) {
          const eq = entry.indexOf("=");
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      } catch {
        // Another user's process: no environment.
      }
      procs.push({ pid: Number(name), ppid, uid, env });
    } catch {
      // Exited while we read it.
    }
  }
  return procs;
}

function splitAgentUid(stateRoot: string): number | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(stateRoot, "split.json"), "utf8"),
    ) as { agentUid?: unknown };
    return typeof raw.agentUid === "number" ? raw.agentUid : null;
  } catch {
    return null;
  }
}

function productionHost(config: RescueConfig): RescueHost {
  const run = (cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString() };
  };
  return {
    systemctl: (args) => run(["systemctl", ...args]),
    journal: (lines) =>
      run([
        "journalctl",
        ...(config.serviceKind === "user" ? ["--user"] : []),
        "-u",
        config.serviceName,
        "-n",
        String(lines),
        "--no-pager",
      ]).stdout,
    readyz: async (baseUrl) => {
      try {
        const res = await fetch(`${baseUrl}/readyz`, {
          signal: AbortSignal.timeout(5_000),
        });
        return { status: res.status, body: await res.text() };
      } catch {
        return null;
      }
    },
    processes: readProcesses,
    kill: (pid, signal) => process.kill(pid, signal),
    selfPid: process.pid,
    selfCgroup: readText("/proc/self/cgroup") ?? "",
    splitAgentUid: splitAgentUid(config.stateRoot),
    officeUid: process.getuid?.() ?? -1,
    diskFree: (path) => {
      try {
        const s = statfsSync(path);
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    },
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
  };
}

if (import.meta.main) {
  // No code from the checkout runs as root: the service user can edit it.
  if (process.getuid?.() === 0) {
    console.error(
      "rescue does not run as root. On a root install run isomux-rescue; otherwise run it as the office's user.",
    );
    process.exit(1);
  }
  const config = loadRescueConfig(
    process.env,
    (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    homedir(),
  );
  const code = await runRescue(
    process.argv.slice(2),
    config,
    productionHost(config),
    {
      log: (line) => console.log(line),
      err: (line) => console.error(line),
    },
  );
  process.exit(code);
}
