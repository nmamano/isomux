// System resource handler — Phase 3a slice 3a.6. The backup health probe on the
// unified REST surface (opId system.backupStatus). office:read + authenticated:
// any signed-in human may read it; AGENT scope lacks office:read and is rejected
// at stage 1.
//
// GET /api/backup/status returns the NORMALIZED wire shape
// { lastRunAt, ok, error, retention, destDir } — a rename/projection of the
// internal BackupStatus (lastBackupAt→lastRunAt, lastBackupOk→ok with null→false,
// lastBackupError→error, backupDir→destDir; `running` is intentionally omitted by
// the spec). The legacy GET /backup/status [retain] keeps returning the RAW
// BackupStatus for its existing consumer; the two paths do not share a body shape
// and must not be confused. The seam owns the mapping (getBackupStatusWire); the
// handler is a pure pass-through.
//
// LEAF over the executor. Only the injected SystemDeps.

import { ok, type RouteHandler } from "../executor.ts";

export interface BackupStatusWire {
  lastRunAt: number | null;
  ok: boolean;
  error: string | null;
  retention: number;
  destDir: string;
}

export interface SystemDeps {
  getBackupStatus(): BackupStatusWire;
}

export function systemHandlers(deps: SystemDeps): Record<string, RouteHandler> {
  return {
    "system.backupStatus": () => ok(deps.getBackupStatus()),
  };
}
