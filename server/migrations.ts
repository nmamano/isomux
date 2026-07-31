// One-shot migration helpers. Currently covers the pre-userid → post-userid
// schema migration: users.json gains a stable `id` field and becomes id-
// keyed; sessions.json/agents.json/cronjob configs swap `username`-as-
// identity for `userId`. Display `username` remains as a snapshot field
// where it exists; behavior-bearing reads switch to userId.
//
// The discipline here is: before ANY file gets rewritten in the new
// schema, copy every potentially-touched file into
// ~/.isomux/backups/pre-userid-migration-<ISO-timestamp>/. The directory
// stays in place forever - operator can roll back by restoring from it.

import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";

const ISOMUX_DIR = STATE_ROOT;
const BACKUPS_DIR = join(ISOMUX_DIR, "backups");

// Files we copy into the backup bundle before the first rewrite. Any file
// that the userid migration may touch belongs here. Missing files are
// skipped (a fresh install has none of these yet).
const BACKUP_FILES = [
  "users.json",
  "sessions.json",
  "invites.json",
  "agents.json",
  "agents-summary.json",
  "cronjobs",
  // tasks.json + agent-history.json snapshot user names but are not
  // identity-bearing; included for symmetry, can be omitted later.
  "tasks.json",
  "agent-history.json",
];

// True iff the migration has not been recorded yet. We use a sentinel file
// inside the backup directory pattern so a successful migration is
// idempotent across restarts.
const SENTINEL_NAME = ".pre-userid-migration-applied";
const SENTINEL = join(ISOMUX_DIR, SENTINEL_NAME);

// Public entry point. Run once at server boot, BEFORE users.ts /
// auth.ts / agent-manager.ts / cronjob-manager.ts touch their state.
//
// Behavior:
//   - If the sentinel exists, return immediately. Migration already ran;
//     subsequent boots are no-ops.
//   - Otherwise: create a timestamped backup directory, copy every
//     existing file from BACKUP_FILES into it, then drop the sentinel.
//
// We deliberately do NOT mutate any state here. The actual schema
// rewriting happens lazily inside each module's load() function, which
// detects pre-migration shapes and upgrades them. This module only
// guarantees that a recoverable snapshot exists before the first rewrite.
export function runPreUseridBackupIfNeeded(): void {
  if (existsSync(SENTINEL)) return;
  try {
    mkdirSync(ISOMUX_DIR, { recursive: true });
  } catch {}
  // If nothing relevant is on disk yet (fresh install), still write the
  // sentinel so we don't keep re-attempting empty backups on every boot.
  // "Relevant" means: a file with content, or a directory with at least
  // one entry. We deliberately treat 0-byte files and empty directories
  // as "not relevant" because other modules (e.g. cronjob-persistence)
  // run mkdirSync at module-load time, which would otherwise trip a
  // false positive here and produce a useless empty backup on every
  // fresh install.
  const hasAnyRelevant = BACKUP_FILES.some((name) => {
    const p = join(ISOMUX_DIR, name);
    if (!existsSync(p)) return false;
    try {
      const s = statSync(p);
      if (s.isDirectory()) return readdirSync(p).length > 0;
      if (s.isFile()) return s.size > 0;
      return false;
    } catch {
      return false;
    }
  });
  if (!hasAnyRelevant) {
    writeSentinel("(no pre-migration state on disk)");
    return;
  }

  const ts = isoStamp();
  const targetDir = join(BACKUPS_DIR, `pre-userid-migration-${ts}`);
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    // If we can't even create the backup dir, refuse to migrate - bail
    // loudly so the operator sees the error and can fix permissions
    // before the next restart attempts the migration.
    throw new Error(
      `[migration] failed to create backup directory ${targetDir}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const name of BACKUP_FILES) {
    const src = join(ISOMUX_DIR, name);
    if (!existsSync(src)) {
      skipped.push(name);
      continue;
    }
    try {
      const s = statSync(src);
      if (s.isDirectory()) {
        copyDirectoryRecursive(src, join(targetDir, name));
      } else {
        copyFileSync(src, join(targetDir, name));
      }
      copied.push(name);
    } catch (err) {
      throw new Error(
        `[migration] failed to copy ${src} into backup: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  writeSentinel(
    `migration backup at ${targetDir} (copied: ${copied.join(", ") || "(none)"}; skipped: ${skipped.join(", ") || "(none)"})`,
  );
  console.log(
    `[migration] pre-userid backup written to ${targetDir} (${copied.length} item(s) copied)`,
  );
}

// Test-only: drops the sentinel so the next call to
// runPreUseridBackupIfNeeded re-runs the backup. Not exported via the
// usual entry points; used only inside the migration test harness.
export function _testResetSentinel(): void {
  try {
    if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
  } catch {}
}

function writeSentinel(note: string): void {
  try {
    writeFileSync(SENTINEL, `${isoStamp()} ${note}\n`);
  } catch (err) {
    console.error("[migration] failed to write sentinel:", err);
  }
}

function isoStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "-" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function copyDirectoryRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const sp = join(src, entry.name);
    const dp = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sp, dp);
    } else if (entry.isFile()) {
      copyFileSync(sp, dp);
    }
    // Skip symlinks, sockets, devices.
  }
}
