import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditActor } from "../shared/audit.ts";

interface AuditContext {
  actor: AuditActor;
  operation: string;
  active: boolean;
  // The full text of a system-prompt surface after this write, for the
  // executor's row (notePromptContent).
  promptContent?: string;
  // Ids the write knows and its answer does not carry (noteAuditTarget).
  targets?: string[];
}
const context = new AsyncLocalStorage<AuditContext>();
// A write to the office, room, agent or member prompt keeps the text after the
// write in its audit row, as memory does (Nil, 2026-10-14). A write with no
// active actor (a boot migration) has no row, so this does nothing there.
export function notePromptContent(text: string | null): void {
  const value = context.getStore();
  if (value?.active) value.promptContent = text ?? "";
}
export function notedPromptContent(): string | undefined {
  const value = context.getStore();
  return value?.active ? value.promptContent : undefined;
}
// An id for the executor's row that the route's targets cannot read from the
// answer: a member's id on an agent's users.update, whose answer carries no user
// record.
export function noteAuditTarget(id: string): void {
  const value = context.getStore();
  if (value?.active) (value.targets ??= []).push(id);
}
export function notedAuditTargets(): string[] {
  const value = context.getStore();
  return value?.active ? (value.targets ?? []) : [];
}
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
