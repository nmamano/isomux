import type { TaskItem } from "./types.ts";

export const AUDIT_ACTOR_KINDS = [
  "member",
  "agent",
  "api_token",
  "cronjob",
  "webhook",
  "admin_cli",
  "setup",
  "app",
  // The secret proxy, for each use of a secret (operation secrets.use). It
  // knows the secret's scope, never the agent.
  "secret_proxy",
  // The server's automatic handoff, which resets an agent's conversation
  // (operation agents.handoff, the agent as target).
  "auto_handoff",
] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];
export interface AuditActor {
  kind: AuditActorKind;
  id: string;
  name: string;
  ownerId?: string;
  runId?: string;
}
export interface AuditEntry {
  sequence: number;
  time: number;
  actor: AuditActor;
  operation: string;
  targets: string[];
  fields: string[];
  taskChanges?: Record<string, { old: unknown; new: unknown }>;
  deletedTask?: Omit<TaskItem, "version">;
  memoryContent?: string;
  // secrets.use: the request that got the value. The path has no query.
  secretUse?: { host: string; method: string; path: string };
}
export interface AuditFilter {
  actorKind?: AuditActorKind;
  actorId?: string;
  ownerId?: string;
  targetId?: string;
  operation?: string;
  from?: number;
  to?: number;
  before?: number;
  limit?: number;
}
export interface AuditPage {
  items: AuditEntry[];
  nextBefore: number | null;
}
export interface TaskHistory {
  createdAt: number;
  createdBy: string;
  items: AuditEntry[];
  nextBefore: number | null;
}
