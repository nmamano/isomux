// System resource handlers for the backup health probe and
// the deployment version identity (release-channel slice C1). backupStatus is
// office:read + authenticated (any human, plus privileged agents); version is
// authenticated-only: every signed-in caller, agents included. Version identity
// is harmless metadata.
//
// GET /api/backup/status returns the NORMALIZED wire shape
// { lastRunAt, ok, error, retention, destDir } - a rename/projection of the
// internal BackupStatus (lastBackupAt→lastRunAt, lastBackupOk→ok with null→false,
// lastBackupError→error, backupDir→destDir; `running` is intentionally omitted by
// the spec). This is the only backup-status route; the legacy GET /backup/status,
// which served the RAW BackupStatus, is retired. The seam owns the mapping
// (getBackupStatusWire); the handler is a pure pass-through.
//
// LEAF over the executor. Only the injected SystemDeps.

import { ok, type RouteHandler } from "../executor.ts";

// The shape moved to shared/contract-shapes.ts when the storage panel became
// its first UI consumer (ui/ imports nothing from server/). Re-exported here so
// it stays the name every existing server caller already reaches for.
import type { BackupStatusWire } from "../../../shared/contract-shapes.ts";
export type { BackupStatusWire };

// GET /api/version - git-derived deployment identity. Same shape as
// server/version.ts VersionInfo; redeclared so this leaf depends only on its
// injected deps.
export interface VersionWire {
  version: string | null;
  commit: string | null;
  release: string | null;
}

export interface SystemDeps {
  getBackupStatus(): BackupStatusWire;
  getVersion(): VersionWire;
}

export function systemHandlers(deps: SystemDeps): Record<string, RouteHandler> {
  return {
    "system.backupStatus": () => ok(deps.getBackupStatus()),
    "system.version": () => ok(deps.getVersion()),
  };
}
