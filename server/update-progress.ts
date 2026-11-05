// Reader for the updater's progress file (scripts/update.sh publish_progress),
// so every open tab can follow an update: the server polls the file, turns it
// into the `progress` field of the update_status event, and broadcasts each
// change.
//
// The file holds only fields the updater generates: a random attempt id, a
// phase name, the result, and the updater's process identity (pid, its start
// ticks and the boot id). The identity never goes on the wire. It lets the
// server tell a dead updater (killed, or the box rebooted) from a running one,
// so a stale "running" record cannot hold an update screen open. Missing or
// mismatched identity proves death; a read the server is not allowed to make
// proves nothing, and the record stays running.
//
// Updaters since task 12dc3a75 also write the target tag and epoch-second
// times: the attempt's start, each phase's start, and the end. The server
// sends the start to the tabs and writes one audit entry per finished attempt
// (server/update-checker.ts auditFinishedUpdate).
//
// Where the file is, from update.conf: a container office reads
// /run/isomux-update, which the host mounts into it read only; system kind
// uses a fixed directory the service user can read and not write
// (/var/lib/isomux-update-public, also home to install.sh's outcome.json);
// user kind uses STATUS_DIR, which belongs to the service user. A container
// office cannot see the host updater's pid, so there only the boot id can
// prove the updater dead.
//
// "requested": the trigger route reports an accepted launch before the
// updater writes its first phase. It lasts until the file names a different
// attempt than it named before the launch (a file that is missing or cannot
// be read names none), and lives only in memory, so the restart ends it. An accepted launch while a live attempt runs adds nothing:
// the running attempt is what the tabs follow.

import { readFileSync } from "fs";
import type { UpdateProgressWire } from "../shared/types.ts";
import type { UpdateConfRead } from "./update-conf.ts";
import { CALVER_RELEASE_RE } from "./version.ts";

export const PUBLIC_PROGRESS_DIR = "/var/lib/isomux-update-public";
export const CONTAINER_PROGRESS_DIR = "/run/isomux-update";
const MAX_PHASES = 64;
const POLL_MS = 1000;

// Every phase name scripts/update.sh can publish.
export const UPDATE_PHASES = [
  "init",
  "validate",
  "fetch",
  "deps",
  "checkout",
  "install",
  "build",
  "stop",
  "start",
  "readiness",
  "finalize",
  "restart",
  "recovery-failed",
  "image",
  "assets",
  "publish",
] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

export interface ProgressRecord {
  attempt: string;
  phase: UpdatePhase;
  result: "running" | "ok" | "failed";
  pid: number;
  pidStart: string;
  boot: string;
  // Written by updaters since task 12dc3a75; an older updater writes none.
  // The release tag, and epoch seconds: the attempt's start, each phase's
  // start in the order entered, and the end (with result ok or failed).
  target?: string;
  started?: number;
  phases?: [UpdatePhase, number][];
  ended?: number;
}

export interface WatcherOptions {
  // A container office: the updater runs on the host, in another pid
  // namespace, so only the boot id can prove it dead.
  updaterInOtherPidNamespace?: boolean;
  // Called once per attempt id when a record with a started time finishes
  // (ok, failed, or a running record whose updater is dead).
  onFinished?: (rec: ProgressRecord) => void;
}

export function progressPathFor(conf: UpdateConfRead): string | null {
  if (conf.state !== "parsed") return null;
  if (conf.values.DEPLOYMENT_KIND === "container") {
    return `${CONTAINER_PROGRESS_DIR}/progress.json`;
  }
  if (conf.values.SERVICE_KIND === "system") {
    return `${PUBLIC_PROGRESS_DIR}/progress.json`;
  }
  if (conf.values.SERVICE_KIND === "user" && conf.values.STATUS_DIR) {
    return `${conf.values.STATUS_DIR}/progress.json`;
  }
  return null;
}

// Strict: anything but the exact shape the updater writes is no record.
export function parseProgress(raw: string): ProgressRecord | null {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  if (typeof r.attempt !== "string" || !/^[a-f0-9]{32}$/.test(r.attempt)) {
    return null;
  }
  if (
    typeof r.phase !== "string" ||
    !(UPDATE_PHASES as readonly string[]).includes(r.phase)
  ) {
    return null;
  }
  if (r.result !== "running" && r.result !== "ok" && r.result !== "failed") {
    return null;
  }
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid < 1) {
    return null;
  }
  if (typeof r.pidStart !== "string" || !/^[0-9]+$/.test(r.pidStart)) {
    return null;
  }
  if (typeof r.boot !== "string" || !/^[a-f0-9-]{36}$/.test(r.boot)) {
    return null;
  }
  const rec: ProgressRecord = {
    attempt: r.attempt,
    phase: r.phase as UpdatePhase,
    result: r.result,
    pid: r.pid,
    pidStart: r.pidStart,
    boot: r.boot,
  };
  // The times are optional (an older updater writes none) and strict when
  // present.
  if (r.target !== undefined) {
    if (typeof r.target !== "string" || !CALVER_RELEASE_RE.test(r.target)) {
      return null;
    }
    rec.target = r.target;
  }
  for (const key of ["started", "ended"] as const) {
    if (r[key] === undefined) continue;
    if (!isSeconds(r[key])) return null;
    rec[key] = r[key];
  }
  if (r.phases !== undefined) {
    if (!Array.isArray(r.phases) || r.phases.length > MAX_PHASES) return null;
    const phases: [UpdatePhase, number][] = [];
    for (const entry of r.phases as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [name, at] = entry as unknown[];
      if (
        typeof name !== "string" ||
        !(UPDATE_PHASES as readonly string[]).includes(name) ||
        !isSeconds(at)
      ) {
        return null;
      }
      phases.push([name as UpdatePhase, at]);
    }
    rec.phases = phases;
  }
  return rec;
}

function isSeconds(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

// A read result: the text, or the errno code that stopped it.
export type ReadText = (path: string) => string | { code: string };

export const readText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    return { code: (err as NodeJS.ErrnoException).code ?? "EIO" };
  }
};

// Start ticks: field 22 of /proc/<pid>/stat. The command name in field 2 can
// hold spaces and parentheses, so count fields after its last ')'.
function startTicks(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  return ticks && /^[0-9]+$/.test(ticks) ? ticks : null;
}

type Liveness = "alive" | "dead" | "unknown";

function updaterLiveness(
  rec: ProgressRecord,
  read: ReadText = readText,
): Liveness {
  const boot = read("/proc/sys/kernel/random/boot_id");
  if (typeof boot !== "string") return "unknown";
  if (boot.trim() !== rec.boot) return "dead";
  const stat = read(`/proc/${rec.pid}/stat`);
  if (typeof stat !== "string") {
    if (stat.code !== "ENOENT") return "unknown";
    // A /proc mounted with hidepid hides other users' processes the same
    // way: if pid 1 is hidden too, absence proves nothing.
    return typeof read("/proc/1/stat") === "string" ? "dead" : "unknown";
  }
  const ticks = startTicks(stat);
  if (ticks === null) return "unknown";
  return ticks === rec.pidStart ? "alive" : "dead";
}

function updaterLivenessIn(
  rec: ProgressRecord,
  read: ReadText,
  pidVisible: boolean,
): Liveness {
  if (pidVisible) return updaterLiveness(rec, read);
  const boot = read("/proc/sys/kernel/random/boot_id");
  if (typeof boot !== "string") return "unknown";
  return boot.trim() === rec.boot ? "unknown" : "dead";
}

// What the tabs see. `requested` holds the attempt the file
// named before the launch (null: no record then).
function progressWire(
  rec: ProgressRecord | null,
  liveness: Liveness,
  requested: { priorAttempt: string | null } | null,
): UpdateProgressWire | null {
  if (requested && (rec === null || rec.attempt === requested.priorAttempt)) {
    return { attempt: null, phase: null, result: "requested", started: null };
  }
  if (!rec) return null;
  return {
    attempt: rec.attempt,
    phase: rec.phase,
    result: resultOf(rec, liveness),
    started: rec.started === undefined ? null : rec.started * 1000,
  };
}

function resultOf(
  rec: ProgressRecord,
  liveness: Liveness,
): ProgressRecord["result"] {
  return rec.result === "running" && liveness === "dead"
    ? "failed"
    : rec.result;
}

export class UpdateProgressWatcher {
  private rec: ProgressRecord | null = null;
  private liveness: Liveness = "unknown";
  private requested: { priorAttempt: string | null } | null = null;
  private wire: UpdateProgressWire | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // The last attempt reported to onFinished.
  private reported: string | null = null;

  constructor(
    private readonly path: string | null,
    private readonly onChange: (p: UpdateProgressWire | null) => void,
    private readonly read: ReadText = readText,
    private readonly options: WatcherOptions = {},
  ) {}

  current(): UpdateProgressWire | null {
    return this.wire;
  }

  // One observation: read the file and the updater's identity, publish on
  // change. A file that cannot be read or parsed counts as no record.
  poll(): void {
    let rec: ProgressRecord | null = null;
    if (this.path) {
      const raw = this.read(this.path);
      rec = typeof raw === "string" ? parseProgress(raw) : null;
    }
    this.rec = rec;
    this.liveness =
      rec && rec.result === "running"
        ? updaterLivenessIn(
            rec,
            this.read,
            !this.options.updaterInOtherPidNamespace,
          )
        : "unknown";
    // Only a new attempt ends the request. A missing, unreadable or
    // malformed file is no attempt at all.
    if (this.requested && rec && rec.attempt !== this.requested.priorAttempt) {
      this.requested = null;
    }
    this.publish();
    this.reportFinished();
  }

  // Runs in the poll timer, where a throw would end the server: a failed
  // report is logged and not retried.
  private reportFinished(): void {
    const rec = this.rec;
    if (!rec || rec.started === undefined || !this.options.onFinished) return;
    const result = resultOf(rec, this.liveness);
    if (result === "running" || this.reported === rec.attempt) return;
    this.reported = rec.attempt;
    try {
      this.options.onFinished({ ...rec, result });
    } catch (err) {
      console.error(
        "[update-progress] could not report a finished update",
        err,
      );
    }
  }

  // Call BEFORE the launch: a fast updater could otherwise write its own
  // attempt before the server notes which attempt came before it.
  beforeTrigger(): { priorAttempt: string | null; liveAttempt: boolean } {
    this.poll();
    return {
      priorAttempt: this.rec?.attempt ?? null,
      liveAttempt: this.rec?.result === "running" && this.liveness !== "dead",
    };
  }

  // Call after systemd accepted the launch.
  triggerAccepted(before: {
    priorAttempt: string | null;
    liveAttempt: boolean;
  }): void {
    if (before.liveAttempt) return;
    this.requested = { priorAttempt: before.priorAttempt };
    this.poll();
  }

  start(): void {
    this.poll();
    this.timer ??= setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private publish(): void {
    const next = progressWire(this.rec, this.liveness, this.requested);
    if (JSON.stringify(next) === JSON.stringify(this.wire)) return;
    this.wire = next;
    this.onChange(next);
  }
}
