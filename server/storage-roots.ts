// The office's PRODUCTION storage roots, in one place.
//
// server/storage-usage.ts is deliberately root-injected - every path is a
// parameter so tests measure a temp fixture tree. That leaves the question of
// where the real paths come from. Two surfaces need the same answer: the
// /api/storage/usage route and the /isomux-storage slash command. isomux-office
// resolves one roots function from this one and hands it to both, so they
// cannot disagree about what "isomux storage" is. A test boot injects its own
// roots in place of this function (StartServerOpts.storageRoots).
//
// Read FRESH on every call, never memoized: the backup destination can be
// reconfigured at runtime, and an updater conf installed after boot must be
// seen without a restart (same reason the route already re-read it per call).

import { STATE_ROOT } from "./config.ts";
import { getBackupStatus, type BackupStatus } from "./backup.ts";
import { readUpdateConf } from "./update-conf.ts";
import type { StorageRoots } from "./storage-usage.ts";

// update.conf's SNAPSHOT_DIR (older updaters' snapshots). null when the box is not updater-managed
// or the conf did not parse - in both cases there are no snapshots to point at.
function updateSnapshotDir(): string | null {
  const conf = readUpdateConf();
  return conf.state === "parsed" ? (conf.values.SNAPSHOT_DIR ?? null) : null;
}

export function productionStorageRoots(
  backupStatus: () => BackupStatus = getBackupStatus,
): StorageRoots {
  return {
    stateRoot: STATE_ROOT,
    backupDir: backupStatus().backupDir,
    snapshotDir: updateSnapshotDir(),
  };
}
