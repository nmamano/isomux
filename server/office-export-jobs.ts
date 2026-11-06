// The owner export route's jobs (task cdd7883d, slice 4). POST
// /api/office/exports starts one export in a child process
// (server/office-export-main.ts), off the server's event loop: it walks every
// file and runs VACUUM INTO. The child writes one .tar.gz into
// <backup folder>/exports/, never the OS temp dir (often RAM) and never the
// state root. One export at a time; a new one deletes the previous file.
//
// A file is kept EXPORT_KEEP_MS and may be downloaded several times in that
// time, so a broken download can retry. A timer deletes it, and the boot sweep
// (the locked boot's too) deletes what a crash or a lock left behind.
//
// Every child exit, timer and stream callback catches its own errors: Bun ends
// the server on a throw in a timer or a .then.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** The child's time limit. */
export const EXPORT_TIME_LIMIT_MS = 30 * 60_000;
/** How long a finished export stays downloadable. */
export const EXPORT_KEEP_MS = 60 * 60_000;
/** The folder in the backup folder that holds export files. */
export const EXPORTS_SUBDIR = "exports";

export type ExportJobState = "running" | "ready" | "failed";

export interface ExportJobStatus {
  state: ExportJobState;
  /** The file's size, once ready. */
  bytes?: number;
  /** The child's error line, when failed. */
  error?: string;
  /** Epoch ms the file is deleted, once ready. */
  expiresAt?: number;
}

/** A started child, as the jobs need it. Production: Bun.spawn. */
export interface ExportChild {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface OfficeExportJobsDeps {
  stateRoot: string;
  /** The folder the exports/ folder lives in (the backup folder). */
  baseDir(): string;
  /** Starts the child that writes `outFile`. Production runs
   *  `bun server/office-export-main.ts <stateRoot> <outFile>`. */
  spawnChild(input: { stateRoot: string; outFile: string }): ExportChild;
  now(): number;
  timeLimitMs?: number;
  keepMs?: number;
}

export type StartExportResult =
  | { ok: true; id: string }
  | { ok: false; status: 409; message: string }
  | { ok: false; status: 500; message: string };

export interface OfficeExportJobs {
  start(): StartExportResult;
  /** null for an unknown or deleted id. */
  status(id: string): ExportJobStatus | null;
  /** The file of a ready job, or null. */
  file(id: string): string | null;
  /** Deletes every file in exports/ that no job holds. Boot runs it. */
  sweep(): void;
  /** Kills a running child and clears the timers. The server stop runs it. */
  stop(): void;
}

/** The folder the child writes the export into before it packs it. The
 *  sweep keeps it while its export runs. */
export function exportPartsDir(outFile: string): string {
  return `${outFile}.parts`;
}

interface Job {
  id: string;
  outFile: string;
  state: ExportJobState;
  child: ExportChild | null;
  limitTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
  bytes?: number;
  error?: string;
  expiresAt?: number;
}

// The longest error line a status carries.
const ERROR_MAX = 300;
// The line Bun prints after an uncaught error.
const BUN_FOOTER = /^Bun v\d+\.\d+/;
// The most stderr the jobs keep: only its last line is used.
const STDERR_MAX = 64 * 1024;

export function createOfficeExportJobs(
  deps: OfficeExportJobsDeps,
): OfficeExportJobs {
  const timeLimitMs = deps.timeLimitMs ?? EXPORT_TIME_LIMIT_MS;
  const keepMs = deps.keepMs ?? EXPORT_KEEP_MS;
  const jobs = new Map<string, Job>();

  const clearTimers = (job: Job) => {
    if (job.limitTimer) clearTimeout(job.limitTimer);
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    job.limitTimer = null;
    job.expiryTimer = null;
  };

  const forget = (job: Job) => {
    clearTimers(job);
    jobs.delete(job.id);
    try {
      rmSync(job.outFile, { force: true });
      rmSync(exportPartsDir(job.outFile), { recursive: true, force: true });
    } catch (err) {
      console.error("[export] could not delete an export file:", err);
    }
  };

  const finish = (job: Job, code: number | null, stderr: string) => {
    try {
      if (jobs.get(job.id) !== job || job.state !== "running") return;
      clearTimers(job);
      job.child = null;
      let bytes: number | null = null;
      if (code === 0 && !job.timedOut) {
        try {
          bytes = statSync(job.outFile).size;
        } catch {
          bytes = null;
        }
      }
      if (bytes !== null) {
        job.state = "ready";
        job.bytes = bytes;
        job.expiresAt = deps.now() + keepMs;
        job.expiryTimer = setTimeout(() => {
          try {
            if (jobs.get(job.id) === job) forget(job);
          } catch (err) {
            console.error("[export] could not expire an export:", err);
          }
        }, keepMs);
        job.expiryTimer.unref?.();
        return;
      }
      job.state = "failed";
      const last = stderr
        .split("\n")
        .map((line) => line.trim())
        // A crash ends with Bun's version line, which says nothing.
        .filter((line) => line !== "" && !BUN_FOOTER.test(line))
        .pop();
      job.error = (
        job.timedOut
          ? `The export took longer than ${Math.round(timeLimitMs / 60_000)} minutes and was stopped`
          : (last ??
            (code === null
              ? "The export stopped"
              : `The export stopped with exit code ${code}`))
      ).slice(0, ERROR_MAX);
      rmSync(job.outFile, { force: true });
      rmSync(exportPartsDir(job.outFile), { recursive: true, force: true });
    } catch (err) {
      console.error("[export] could not finish an export:", err);
    }
  };

  const killChild = (job: Job) => {
    try {
      job.child?.kill("SIGKILL");
    } catch (err) {
      console.error("[export] could not stop the export:", err);
    }
  };

  // Reads a stream to the end; keeps the tail of its text. Never rejects.
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    let text = "";
    try {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        text += decoder.decode(chunk, { stream: true });
        if (text.length > STDERR_MAX) text = text.slice(-STDERR_MAX);
      }
    } catch {
      // A broken pipe: keep what came.
    }
    return text;
  };

  return {
    start() {
      for (const job of jobs.values())
        if (job.state === "running")
          return {
            ok: false,
            status: 409,
            message: "An export is already running.",
          };
      let dir: string;
      try {
        dir = join(deps.baseDir(), EXPORTS_SUBDIR);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
      } catch (err) {
        console.error("[export] could not make the exports folder:", err);
        return {
          ok: false,
          status: 500,
          message: "The exports folder could not be made.",
        };
      }
      // One export at a time: a new one deletes the previous file.
      for (const job of [...jobs.values()]) forget(job);
      const id = randomUUID();
      const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
      const outFile = join(
        dir,
        `isomux-export-${stamp}-${id.slice(0, 8)}.tar.gz`,
      );
      let child: ExportChild;
      try {
        child = deps.spawnChild({ stateRoot: deps.stateRoot, outFile });
      } catch (err) {
        console.error("[export] could not start the export:", err);
        return {
          ok: false,
          status: 500,
          message: "The export could not start.",
        };
      }
      const job: Job = {
        id,
        outFile,
        state: "running",
        child,
        limitTimer: null,
        expiryTimer: null,
        timedOut: false,
      };
      jobs.set(id, job);
      job.limitTimer = setTimeout(() => {
        try {
          job.timedOut = true;
          killChild(job);
        } catch (err) {
          console.error("[export] could not stop a late export:", err);
        }
      }, timeLimitMs);
      job.limitTimer.unref?.();
      const stdout = drain(child.stdout);
      const stderr = drain(child.stderr);
      const exited = (async () => {
        try {
          return await child.exited;
        } catch {
          return null;
        }
      })();
      void Promise.all([exited, stderr, stdout])
        .then(([code, text]) => finish(job, code, text))
        .catch((err: unknown) => {
          console.error("[export] could not finish an export:", err);
        });
      return { ok: true, id };
    },
    status(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (job.state === "running") return { state: "running" };
      if (job.state === "failed")
        return { state: "failed", error: job.error ?? "" };
      return {
        state: "ready",
        bytes: job.bytes ?? 0,
        expiresAt: job.expiresAt ?? 0,
      };
    },
    file(id) {
      const job = jobs.get(id);
      return job && job.state === "ready" ? job.outFile : null;
    },
    sweep() {
      let dir: string;
      try {
        dir = join(deps.baseDir(), EXPORTS_SUBDIR);
      } catch (err) {
        console.error("[export] could not find the exports folder:", err);
        return;
      }
      const held = new Set<string>();
      for (const job of jobs.values()) {
        held.add(basename(job.outFile));
        held.add(basename(exportPartsDir(job.outFile)));
      }
      removeEntries(dir, (name) => !held.has(name));
    },
    stop() {
      for (const job of jobs.values()) {
        clearTimers(job);
        if (job.state === "running") killChild(job);
      }
    },
  };
}

// Removes the entries of `dir` that `remove` picks. No folder: nothing to do.
function removeEntries(dir: string, remove: (name: string) => boolean): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!remove(name)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch (err) {
      console.error(`[export] could not delete ${name}:`, err);
    }
  }
}

/** The production child: `bun server/office-export-main.ts <stateRoot>
 *  <outFile>`, with the server's environment. */
export function spawnExportChildProcess(input: {
  stateRoot: string;
  outFile: string;
}): ExportChild {
  return Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "office-export-main.ts"),
      input.stateRoot,
      input.outFile,
    ],
    // The live environment: Bun.spawn's default is the one at startup.
    { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
}

/** Deletes every export file in <baseDir>/exports/. The locked boot runs it:
 *  no export survives a lock. */
export function sweepExportFiles(baseDir: string): void {
  removeEntries(join(baseDir, EXPORTS_SUBDIR), () => true);
}
