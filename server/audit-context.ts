import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditActor } from "../shared/audit.ts";

interface AuditContext {
  actor: AuditActor;
  operation: string;
  active: boolean;
}
const context = new AsyncLocalStorage<AuditContext>();
export function requireAuditContext(): AuditContext {
  const value = context.getStore();
  if (!value?.active) throw new Error("Write requires an active audit actor");
  return value;
}
export async function withAuditContext<T>(
  actor: AuditActor,
  operation: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const value = { actor, operation, active: true };
  return context.run(value, async () => {
    try {
      return await fn();
    } finally {
      value.active = false;
    }
  });
}
// Synchronous callers (including fixture writers) have the same lifetime rule.
export function withAuditContextSync<T>(
  actor: AuditActor,
  operation: string,
  fn: () => T,
): T {
  const value = { actor, operation, active: true };
  return context.run(value, () => {
    try {
      return fn();
    } finally {
      value.active = false;
    }
  });
}
