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
// Where the file is, from update.conf: system kind uses a fixed directory the
// service user can read and not write (/var/lib/isomux-update-public, also
// home to install.sh's outcome.json); user kind uses STATUS_DIR, which belongs
// to the service user. A container office reads its update.conf too, but the
// host's file does not reach it, so it never sees progress.
//
// "requested": the trigger route reports an accepted launch before the
// updater writes its first phase. It lasts until the file names a different
// attempt than it named before the launch (a file that is missing or cannot
// be read names none), and lives only in memory, so the restart ends it. An accepted launch while a live attempt runs adds nothing:
// the running attempt is what the tabs follow.

import { readFileSync } from "fs";
import type { UpdateProgressWire } from "../shared/types.ts";
import type { UpdateConfRead } from "./update-conf.ts";

export const PUBLIC_PROGRESS_DIR = "/var/lib/isomux-update-public";
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
}

export function progressPathFor(conf: UpdateConfRead): string | null {
  if (conf.state !== "parsed") return null;
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
  return {
    attempt: r.attempt,
    phase: r.phase as UpdatePhase,
    result: r.result,
    pid: r.pid,
    pidStart: r.pidStart,
    boot: r.boot,
  };
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
export function startTicks(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  return ticks && /^[0-9]+$/.test(ticks) ? ticks : null;
}

export type Liveness = "alive" | "dead" | "unknown";

export function updaterLiveness(
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

// What the tabs see, pure for tests. `requested` holds the attempt the file
// named before the launch (null: no record then).
export function progressWire(
  rec: ProgressRecord | null,
  liveness: Liveness,
  requested: { priorAttempt: string | null } | null,
): UpdateProgressWire | null {
  if (requested && (rec === null || rec.attempt === requested.priorAttempt)) {
    return { attempt: null, phase: null, result: "requested" };
  }
  if (!rec) return null;
  const result =
    rec.result === "running" && liveness === "dead" ? "failed" : rec.result;
  return { attempt: rec.attempt, phase: rec.phase, result };
}

export class UpdateProgressWatcher {
  private rec: ProgressRecord | null = null;
  private liveness: Liveness = "unknown";
  private requested: { priorAttempt: string | null } | null = null;
  private wire: UpdateProgressWire | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly path: string | null,
    private readonly onChange: (p: UpdateProgressWire | null) => void,
    private readonly read: ReadText = readText,
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
        ? updaterLiveness(rec, this.read)
        : "unknown";
    // Only a new attempt ends the request. A missing, unreadable or
    // malformed file is no attempt at all.
    if (this.requested && rec && rec.attempt !== this.requested.priorAttempt) {
      this.requested = null;
    }
    this.publish();
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
