// The office's PRODUCTION storage roots, in one place (task 1387a9c7).
//
// server/storage-usage.ts is deliberately root-injected — every path is a
// parameter so tests measure a temp fixture tree. That leaves the question of
// where the real paths come from, and there are now two callers that need the
// same answer: the /api/storage/usage route (server/isomux-office.ts) and the
// /isomux-storage slash command (server/command-handlers.ts). Resolving them
// twice would let the two surfaces disagree about what "isomux storage" is, so
// they resolve here instead.
//
// Read FRESH on every call, never memoized: the backup destination can be
// reconfigured at runtime, and an updater conf installed after boot must be
// seen without a restart (same reason the route already re-read it per call).

import { STATE_ROOT } from "./config.ts";
import { getBackupStatus } from "./backup.ts";
import { readUpdateConf } from "./update-conf.ts";
import type { StorageRoots } from "./storage-usage.ts";

// scripts/update.sh's SNAPSHOT_DIR. null when the box is not updater-managed
// or the conf did not parse — in both cases there are no snapshots to point at.
function updateSnapshotDir(): string | null {
  const conf = readUpdateConf();
  return conf.state === "parsed" ? (conf.values.SNAPSHOT_DIR ?? null) : null;
}

export function productionStorageRoots(): StorageRoots {
  return {
    stateRoot: STATE_ROOT,
    backupDir: getBackupStatus().backupDir,
    snapshotDir: updateSnapshotDir(),
  };
}
