// The audit rows of a lock and an unlock (task cdd7883d), written by whoever
// writes the marker: the host command while the office is down (one writer on
// office.sqlite), or the lockdown route before it exits.

import { join } from "node:path";
import type { AuditActor } from "../shared/audit.ts";
import {
  OFFICE_DATABASE,
  createAuditStore,
  openOfficeDatabase,
} from "./audit-store.ts";

/** The host command's actor. */
export const RESCUE_ACTOR: AuditActor = {
  kind: "admin_cli",
  id: "rescue",
  name: "rescue",
};

const OPERATIONS = {
  lockdown: { operation: "office.lockdown" },
  unlock: { operation: "office.unlock" },
} as const;

export function recordLockAudit(
  stateRoot: string,
  kind: keyof typeof OPERATIONS,
  input: { actor: AuditActor; reason: string; now: Date },
): void {
  const db = openOfficeDatabase(join(stateRoot, OFFICE_DATABASE));
  try {
    createAuditStore(db).append({
      ...OPERATIONS[kind],
      actor: input.actor,
      targets: ["office"],
      fields: [],
      ...(input.reason ? { lockdown: { reason: input.reason } } : {}),
      time: +input.now,
    });
  } finally {
    db.close();
  }
}
