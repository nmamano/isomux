import type { TaskItem } from "./types.ts";

export type AuditActorKind = "member" | "agent" | "api_token" | "cronjob" | "webhook" | "admin_cli" | "setup" | "app";
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
export interface AuditPage { items: AuditEntry[]; nextBefore: number | null }
export interface TaskHistory { createdAt: number; createdBy: string; items: AuditEntry[]; nextBefore: number | null }
