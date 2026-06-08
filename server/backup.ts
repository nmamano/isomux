// Daily backup of ~/.isomux to a local tarball.
//
// Approach: live tar (no quiesce). Configs are written via atomicWriteFileSync
// in persistence.ts, so tar can't capture a half-written JSON. JSONL log files
// are append-only and line-tolerant, so a torn final line in a snapshot is
// harmless. The expensive work runs in a subprocess; the bun event loop stays
// responsive while tar runs.
//
// Schedule: interval-since-last. On startup and every hour, check the newest
// existing tarball's mtime; if it's older than 24h (or there's none), back up.
// No wall-clock time of day, no missed-run logic.
//
// Retention: keep the 7 newest tarballs, prune the rest.
//
// Destination: $ISOMUX_BACKUP_DIR or ~/isomux-backups by default.
//
// Restore: documented in internal-docs/backup-restore.md (no automation).

import { join, basename, dirname } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { errMessage } from "../shared/errors.ts";
import { STATE_ROOT } from "./config.ts";

const HOME = homedir();
// Back up the active state root, tarred as `-C <parent> <name>` so the archive
// holds a single top-level dir. In production STATE_ROOT is ~/.isomux, so this
// is byte-for-byte equivalent to the previous `-C $HOME .isomux`.
const STATE_ROOT_PARENT = dirname(STATE_ROOT);
const STATE_ROOT_NAME = basename(STATE_ROOT);
const BACKUP_DIR =
  process.env.ISOMUX_BACKUP_DIR || join(HOME, "isomux-backups");
const RETENTION = 7;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FILENAME_PATTERN = /^isomux-\d{4}-\d{2}-\d{2}\.tar\.gz$/;

let lastBackupAt: number | null = null;
let lastBackupOk: boolean | null = null;
let lastBackupError: string | null = null;
let lastBackupFile: string | null = null;
let running = false;

export interface BackupStatus {
  backupDir: string;
  retention: number;
  lastBackupAt: number | null;
  lastBackupOk: boolean | null;
  lastBackupError: string | null;
  lastBackupFile: string | null;
  running: boolean;
}

export function getBackupStatus(): BackupStatus {
  return {
    backupDir: BACKUP_DIR,
    retention: RETENTION,
    lastBackupAt,
    lastBackupOk,
    lastBackupError,
    lastBackupFile,
    running,
  };
}

function listExistingBackups(): string[] {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => FILENAME_PATTERN.test(f))
    .sort(); // ISO-date filenames sort lexicographically
}

function newestBackupMtime(): number | null {
  const files = listExistingBackups();
  if (files.length === 0) return null;
  let newest = 0;
  for (const f of files) {
    try {
      const m = statSync(join(BACKUP_DIR, f)).mtimeMs;
      if (m > newest) newest = m;
    } catch {}
  }
  return newest || null;
}

function todayDateStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function runBackup() {
  if (running) return;
  running = true;
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = join(BACKUP_DIR, `isomux-${todayDateStr()}.tar.gz`);
    const proc = Bun.spawn(
      ["tar", "-czf", dest, "-C", STATE_ROOT_PARENT, STATE_ROOT_NAME],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    // GNU tar exits 1 when files changed during read (e.g. a JSONL got an
    // appended line while we were reading it). The archive is still valid;
    // we treat 1 as a warning. Anything >= 2 is a real failure.
    if (exitCode >= 2) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar exit ${exitCode}: ${stderr.trim().slice(0, 500)}`);
    }
    if (exitCode === 1) {
      console.warn(
        "[backup] tar exit 1 (file(s) changed during archive — archive still valid)",
      );
    }
    const files = listExistingBackups();
    while (files.length > RETENTION) {
      const oldest = files.shift()!;
      try {
        unlinkSync(join(BACKUP_DIR, oldest));
      } catch {}
    }
    lastBackupAt = Date.now();
    lastBackupOk = true;
    lastBackupError = null;
    lastBackupFile = basename(dest);
    console.log(`[backup] wrote ${lastBackupFile}`);
  } catch (err) {
    lastBackupAt = Date.now();
    lastBackupOk = false;
    lastBackupError = errMessage(err);
    lastBackupFile = null;
    console.error("[backup] failed:", err);
  } finally {
    running = false;
  }
}

async function tick() {
  const newest = newestBackupMtime();
  if (newest === null || Date.now() - newest >= BACKUP_INTERVAL_MS) {
    await runBackup();
  }
}

export function startBackupScheduler() {
  // Fire on startup, then check every hour.
  void tick();
  setInterval(() => void tick(), CHECK_INTERVAL_MS);
}
