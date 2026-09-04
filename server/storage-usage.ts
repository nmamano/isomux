// Disk-usage breakdown of the office's persisted footprint.
//
// Office state grows without bound: conversation transcripts and attachments
// under <stateRoot>/logs are never pruned, and codex-home is written by the
// codex CLI at whatever rate it likes. Backups (server/backup.ts, 7 newest) and
// pre-update snapshots (scripts/update.sh, SNAPSHOT_KEEP=3) already cap
// themselves, but they live OUTSIDE the state root, so an operator asking "what
// is filling this disk?" has to know three separate locations. This module is
// the one answer.
//
// READ-ONLY. Nothing here deletes; pruning lives in storage-prune.ts.
//
// Seam discipline: every root is INJECTED (measureStorage takes explicit paths),
// so tests measure a temp fixture tree and never stat the real ~/.isomux. The
// production roots are resolved by the caller (server/isomux-office.ts) from
// STATE_ROOT, the backup dir, and the updater conf.
//
// Symlinks are counted by their own (tiny) size and never followed: following
// them would double-count a link into the tree and, worse, could wander outside
// the roots entirely.

import { join } from "path";
import { readdirSync, lstatSync } from "fs";
import type {
  StorageCategoryId,
  StorageCategoryWire,
  AgentStorageWire,
  StorageUsageWire,
} from "../shared/contract-shapes.ts";

// The wire contract IS the domain type here - no projection layer, so the route
// response and the measurement cannot drift. Local aliases keep the call sites
// readable.
export type StorageCategory = StorageCategoryWire;
export type AgentStorage = AgentStorageWire;
export type StorageUsage = StorageUsageWire;
export type { StorageCategoryId };

export interface DirUsage {
  bytes: number;
  files: number;
}

const ZERO: DirUsage = { bytes: 0, files: 0 };

// "Exists and could be read", proven by reading it - the contract `available`
// promises. existsSync would report a directory we cannot open as available.
function isReadableDir(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface StorageRoots {
  stateRoot: string;
  // server/backup.ts's destination - outside the state root by design.
  backupDir: string | null;
  // scripts/update.sh's SNAPSHOT_DIR - outside the state root because a
  // rollback replaces the state root wholesale. null when the box is not
  // updater-managed or the conf did not parse.
  snapshotDir: string | null;
}

// Recursive size of a directory tree. Missing paths measure as zero rather than
// throwing: every root here is optional on some deployment shape. Unreadable
// entries are skipped - a usage report must never fail closed on one bad file.
export function measureTree(path: string): DirUsage {
  let bytes = 0;
  let files = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      // Files, symlinks, sockets, fifos: lstat, never follow.
      try {
        bytes += lstatSync(full).size;
        files++;
      } catch {
        // Vanished between readdir and lstat (a live office is writing
        // underneath us). Skip it.
      }
    }
  }
  return { bytes, files };
}

interface LogsBreakdown {
  transcripts: DirUsage;
  attachments: DirUsage;
  metadata: DirUsage;
  agents: AgentStorage[];
}

// One pass over <stateRoot>/logs producing both the category split and the
// per-agent detail. The layout is logs/<agentId>/{<sessionId>.jsonl,
// sessions.json, files/**} - see server/persistence.ts.
function measureLogs(logsDir: string): LogsBreakdown {
  const transcripts: DirUsage = { bytes: 0, files: 0 };
  const attachments: DirUsage = { bytes: 0, files: 0 };
  const metadata: DirUsage = { bytes: 0, files: 0 };
  const agents: AgentStorage[] = [];
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(logsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { transcripts, attachments, metadata, agents };
  }

  for (const agentId of agentDirs) {
    const agentDir = join(logsDir, agentId);
    let transcriptBytes = 0;
    let attachmentBytes = 0;
    let sessions = 0;
    let lastActivityAt: number | null = null;
    let entries;
    try {
      entries = readdirSync(agentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(agentDir, entry.name);
      if (entry.isDirectory()) {
        // ONLY the two attachment directories count as attachments: `files/`
        // (current) and `images/` (the pre-`files/` layout getFilePath still
        // falls back to). Any other subdir is unexpected and falls through to
        // other-state via the subtraction, so the category name stays exact
        // rather than absorbing whatever else appears here.
        //
        // Only `files/` is prunable - `images/` is legacy and left alone - so
        // reported attachment bytes can slightly exceed prunable ones. That is
        // the safe direction for a number an operator reads before deleting.
        if (entry.name !== "files" && entry.name !== "images") continue;
        const sub = measureTree(full);
        attachmentBytes += sub.bytes;
        attachments.bytes += sub.bytes;
        attachments.files += sub.files;
        continue;
      }
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (entry.name.endsWith(".jsonl")) {
        transcriptBytes += stat.size;
        sessions++;
        transcripts.bytes += stat.size;
        transcripts.files++;
        if (lastActivityAt === null || stat.mtimeMs > lastActivityAt) {
          lastActivityAt = stat.mtimeMs;
        }
      } else {
        // sessions.json and anything else alongside it: metadata. Tiny, but
        // counted so the categories still sum to the state-root total.
        metadata.bytes += stat.size;
        metadata.files++;
      }
    }
    agents.push({
      agentId,
      transcriptBytes,
      attachmentBytes,
      sessions,
      lastActivityAt,
    });
  }

  agents.sort(
    (a, b) =>
      b.transcriptBytes +
      b.attachmentBytes -
      (a.transcriptBytes + a.attachmentBytes),
  );
  return { transcripts, attachments, metadata, agents };
}

// Measure the office footprint across all three locations.
export function measureStorage(roots: StorageRoots): StorageUsage {
  const { stateRoot, backupDir, snapshotDir } = roots;
  const logsDir = join(stateRoot, "logs");
  const codexHome = join(stateRoot, "codex-home");
  const providerHomes = join(stateRoot, "provider-homes");
  const cronjobs = join(stateRoot, "cronjobs");
  const memory = join(stateRoot, "memory");

  const total = measureTree(stateRoot);
  const logs = measureLogs(logsDir);
  const codex = measureTree(codexHome);
  const providers = measureTree(providerHomes);
  const cron = measureTree(cronjobs);
  const mem = measureTree(memory);

  // Everything in the state root the named categories did not claim:
  // agents.json, tasks.json, users.json, state/, slide/, tls/, ...
  // Derived by subtraction so the categories always sum to stateRootBytes.
  const claimedBytes =
    logs.transcripts.bytes +
    logs.attachments.bytes +
    logs.metadata.bytes +
    codex.bytes +
    providers.bytes +
    cron.bytes +
    mem.bytes;
  const claimedFiles =
    logs.transcripts.files +
    logs.attachments.files +
    logs.metadata.files +
    codex.files +
    providers.files +
    cron.files +
    mem.files;

  // `available` is computed PER CATEGORY PATH, and by actually reading the
  // directory rather than testing for existence: the wire contract says "exists
  // and could be read", and existsSync cannot tell an unreadable directory from
  // a readable one. A box with no cronjobs must not report cronjobs as
  // available just because the state root is there.
  const cat = (
    id: StorageCategoryId,
    dir: string | null,
    usage: DirUsage,
  ): StorageCategory =>
    dir === null
      ? { id, path: null, available: false, bytes: 0, files: 0 }
      : { id, path: dir, available: isReadableDir(dir), ...usage };

  const categories: StorageCategory[] = [
    cat("transcripts", logsDir, logs.transcripts),
    cat("attachments", logsDir, logs.attachments),
    cat("session-metadata", logsDir, logs.metadata),
    cat("codex-home", codexHome, codex),
    cat("provider-homes", providerHomes, providers),
    cat("cronjobs", cronjobs, cron),
    cat("memory", memory, mem),
    cat("other-state", stateRoot, {
      bytes: Math.max(0, total.bytes - claimedBytes),
      files: Math.max(0, total.files - claimedFiles),
    }),
    cat("backups", backupDir, backupDir ? measureTree(backupDir) : ZERO),
    cat(
      "update-snapshots",
      snapshotDir,
      snapshotDir ? measureTree(snapshotDir) : ZERO,
    ),
  ];

  return {
    stateRoot,
    measuredAt: Date.now(),
    stateRootBytes: total.bytes,
    categories,
    agents: logs.agents,
  };
}

// The projection for anyone who is not the office owner: sizes only. The
// per-agent breakdown enumerates log dirs for agents in rooms the caller may
// not be able to see, and the paths describe the server's filesystem layout -
// neither is needed to answer "what is filling the disk?".
export function aggregateOnly(usage: StorageUsage): StorageUsage {
  return {
    ...usage,
    stateRoot: null,
    categories: usage.categories.map((c) => ({ ...c, path: null })),
    agents: [],
  };
}

// Measuring the whole tree walks ~10k inodes. Cheap (well under a second) but
// not free, and a UI poll or a curl loop should not be able to spin it. One
// in-flight measurement at a time, result reused for TTL ms.
const CACHE_TTL_MS = 30_000;
let cached: { key: string; usage: StorageUsage } | null = null;

export function measureStorageCached(
  roots: StorageRoots,
  ttlMs = CACHE_TTL_MS,
  now = Date.now(),
): StorageUsage {
  const key = `${roots.stateRoot}\0${roots.backupDir ?? ""}\0${roots.snapshotDir ?? ""}`;
  if (cached && cached.key === key && now - cached.usage.measuredAt < ttlMs) {
    return cached.usage;
  }
  const usage = measureStorage(roots);
  cached = { key, usage };
  return usage;
}

// Test-only: forget the memoized measurement.
export function resetStorageUsageCache() {
  cached = null;
}
