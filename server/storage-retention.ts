// The automatic cleanup of logs/ (task 3f8db20b). Once a day it compresses
// transcripts older than compressAfterDays (lossless, on by default). When an
// owner set deleteAfterDays, it first runs the manual prune at that age:
// transcripts (keeping the RETENTION_KEEP_PER_AGENT newest sessions of each
// live agent), then the attachments no transcript references. Deletes are off
// until an owner sets an age.
//
// backup.ts's tick runs it before the backup (setBackupPreTick), so the
// archive gets the compressed transcripts. It waits for restoreAgents, holds
// the storage lock (StorageOps.exclusive) for the whole run, and reads every
// transcript for the attachments plan through an async scan
// (scanReferencedAttachments), so the event loop does not stall.

import { join } from "path";
import { readFileSync } from "fs";
import type {
  LogRetentionReq,
  LogRetentionRunWire,
} from "../shared/contract-shapes.ts";
import { STATE_ROOT } from "./config.ts";
import type { StorageOps } from "./office-storage-routes.ts";
import {
  atomicWriteFileSync,
  loadLogRetentionRaw,
  saveLogRetentionRaw,
} from "./persistence.ts";
import { StorageBusyError } from "./routes/handlers/storage.ts";
import {
  QUEUE_STATE_UNKNOWN,
  scanReferencedAttachments,
  type ReferenceIndex,
} from "./storage-prune.ts";

export interface LogRetentionSettings {
  compressAfterDays: number;
  // null: automatic deletes are off.
  deleteAfterDays: number | null;
}

export const DEFAULT_LOG_RETENTION: LogRetentionSettings = {
  compressAfterDays: 7,
  deleteAfterDays: null,
};

export const LOG_RETENTION_DAYS_RANGE = { min: 1, max: 3650 } as const;

// keepPerAgent of the automatic transcripts prune.
export const RETENTION_KEEP_PER_AGENT = 2;

// A run is due this long after the last one started.
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type LogRetentionRun = LogRetentionRunWire;

// STATE_ROOT/log-retention.json.
export interface LogRetentionState {
  lastRunAt: number | null;
  lastRun: LogRetentionRun | null;
  lastError: string | null;
}

const STATE_FILE = () => join(STATE_ROOT, "log-retention.json");

function validDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= LOG_RETENTION_DAYS_RANGE.min &&
    value <= LOG_RETENTION_DAYS_RANGE.max
  );
}

// The stored settings, with defaults for absent or invalid fields.
export function loadLogRetentionSettings(): LogRetentionSettings {
  const raw = loadLogRetentionRaw();
  return {
    compressAfterDays: validDays(raw.compressAfterDays)
      ? raw.compressAfterDays
      : DEFAULT_LOG_RETENTION.compressAfterDays,
    deleteAfterDays: validDays(raw.deleteAfterDays)
      ? raw.deleteAfterDays
      : DEFAULT_LOG_RETENTION.deleteAfterDays,
  };
}

// Why an input is refused, or null. Checks every field; writes nothing.
export function logRetentionSettingsShapeError(input: {
  compressAfterDays?: unknown;
  deleteAfterDays?: unknown;
}): string | null {
  const { min, max } = LOG_RETENTION_DAYS_RANGE;
  if (
    input.compressAfterDays !== undefined &&
    !validDays(input.compressAfterDays)
  )
    return `compressAfterDays must be a whole number from ${min} to ${max}`;
  if (
    input.deleteAfterDays !== undefined &&
    input.deleteAfterDays !== null &&
    !validDays(input.deleteAfterDays)
  )
    return `deleteAfterDays must be a whole number from ${min} to ${max}, or null for off`;
  return null;
}

// Validates the whole input before it writes. An omitted field keeps its
// value. A save does not start a run.
export function saveLogRetentionSettings(
  input: LogRetentionReq,
): { ok: true; settings: LogRetentionSettings } | { ok: false; error: string } {
  const shape = logRetentionSettingsShapeError(input);
  if (shape) return { ok: false, error: shape };
  const next = { ...loadLogRetentionSettings() };
  if (input.compressAfterDays !== undefined)
    next.compressAfterDays = input.compressAfterDays;
  if (input.deleteAfterDays !== undefined)
    next.deleteAfterDays = input.deleteAfterDays;
  try {
    saveLogRetentionRaw(next);
  } catch (err) {
    return {
      ok: false,
      error: `could not save the cleanup settings: ${errText(err)}`,
    };
  }
  return { ok: true, settings: next };
}

const NEVER_RUN: LogRetentionState = {
  lastRunAt: null,
  lastRun: null,
  lastError: null,
};

function isRun(value: unknown): value is LogRetentionRun {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return [
    "compressed",
    "compressBytesSaved",
    "transcriptsDeleted",
    "filesDeleted",
    "bytesDeleted",
  ].every((k) => typeof v[k] === "number");
}

// The state file; an absent or unreadable file reads as never run.
export function readLogRetentionState(): LogRetentionState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE(), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      lastRunAt: typeof raw.lastRunAt === "number" ? raw.lastRunAt : null,
      lastRun: isRun(raw.lastRun) ? raw.lastRun : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    };
  } catch {
    return { ...NEVER_RUN };
  }
}

export function writeLogRetentionState(state: LogRetentionState): void {
  atomicWriteFileSync(STATE_FILE(), JSON.stringify(state, null, 2));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface LogRetentionDeps {
  ops: Pick<
    StorageOps,
    "planPrune" | "applyPrune" | "planCompress" | "applyCompress" | "exclusive"
  >;
  logsDir: string;
  now(): number;
  loadSettings(): LogRetentionSettings;
  readState(): LogRetentionState;
  writeState(state: LogRetentionState): void;
  // False until restoreAgents resolved: no run before that.
  isRestored(): boolean;
  // Default scanReferencedAttachments(logsDir).
  scanReferences?(logsDir: string): Promise<ReferenceIndex>;
}

export type LogRetentionOutcome =
  | "not-restored"
  | "not-due"
  // Another run, or a manual apply, holds the storage lock. lastRunAt is not
  // written, so the next check tries again.
  | "busy"
  // The run finished; lastRunAt and lastRun are written, and lastError when a
  // step failed or stopped (a queue state that could not be read).
  | "ran";

export interface LogRetention {
  runIfDue(): Promise<LogRetentionOutcome>;
  isRunning(): boolean;
}

// A last run in the future (the clock moved back, or the state came from
// another box) counts as due: otherwise the cleanup would stop until the
// clock caught up.
function isDue(lastRunAt: number | null, now: number): boolean {
  if (lastRunAt === null || lastRunAt > now) return true;
  return now - lastRunAt >= RETENTION_INTERVAL_MS;
}

export function createLogRetention(deps: LogRetentionDeps): LogRetention {
  let running = false;

  // The steps, in order. A step that throws ends the run; what the earlier
  // steps did stays in `run`.
  async function steps(
    settings: LogRetentionSettings,
    run: LogRetentionRun,
  ): Promise<string | null> {
    const { ops } = deps;
    let stopped: string | null = null;
    if (settings.deleteAfterDays !== null) {
      const policy = {
        olderThanDays: settings.deleteAfterDays,
        keepPerAgent: RETENTION_KEEP_PER_AGENT,
      };
      // Transcripts first: the files they referenced become unreferenced.
      const transcripts = ops.applyPrune(ops.planPrune("transcripts", policy));
      run.transcriptsDeleted += transcripts.deleted;
      run.bytesDeleted += transcripts.bytes;
      if (transcripts.aborted) stopped = transcripts.aborted;

      // The apply plans again, so it gets the same lookup as the plan: the
      // default reader would read every transcript on the event loop.
      const index = await (deps.scanReferences ?? scanReferencedAttachments)(
        deps.logsDir,
      );
      const opts = { referencedAttachments: index.lookup };
      // keepPerAgent 0: the attachments planner ignores it, but the apply
      // stamps lastPrune("attachments") with this policy, and an open
      // attachments ask (keepPerAgent 0) closes only on a stamp that covers it.
      const plan = ops.planPrune(
        "attachments",
        { olderThanDays: settings.deleteAfterDays, keepPerAgent: 0 },
        opts,
      );
      if (plan.skipped.some((s) => s.reason === QUEUE_STATE_UNKNOWN)) {
        // Unknown is not empty: no file is deleted until the queue state is
        // readable again. The compress below does not depend on it.
        stopped =
          "the message queue could not be read, so no chat files were deleted";
      } else {
        const files = ops.applyPrune(plan, opts);
        run.filesDeleted += files.deleted;
        run.bytesDeleted += files.bytes;
        if (files.aborted) stopped = files.aborted;
      }
    }
    const compressed = await ops.applyCompress(
      ops.planCompress(settings.compressAfterDays),
    );
    run.compressed += compressed.compressed;
    run.compressBytesSaved += compressed.bytesBefore - compressed.bytesAfter;
    if (compressed.aborted) stopped = compressed.aborted;
    return stopped;
  }

  return {
    async runIfDue() {
      if (!deps.isRestored()) return "not-restored";
      if (running) return "busy";
      if (!isDue(deps.readState().lastRunAt, deps.now())) return "not-due";
      running = true;
      try {
        return await deps.ops.exclusive(async () => {
          // Read once: a save during the run applies at the next run.
          const settings = deps.loadSettings();
          const startedAt = deps.now();
          const run: LogRetentionRun = {
            compressed: 0,
            compressBytesSaved: 0,
            transcriptsDeleted: 0,
            filesDeleted: 0,
            bytesDeleted: 0,
          };
          let lastError: string | null;
          try {
            lastError = await steps(settings, run);
          } catch (err) {
            lastError = errText(err);
          }
          if (lastError) console.error(`[retention] ${lastError}`);
          else
            console.log(
              `[retention] compressed ${run.compressed}, deleted ${run.transcriptsDeleted} transcripts and ${run.filesDeleted} files`,
            );
          deps.writeState({ lastRunAt: startedAt, lastRun: run, lastError });
          return "ran" as const;
        });
      } catch (err) {
        if (err instanceof StorageBusyError) {
          console.log(
            "[retention] storage busy; trying again at the next check",
          );
          return "busy";
        }
        throw err;
      } finally {
        running = false;
      }
    },
    isRunning: () => running,
  };
}
