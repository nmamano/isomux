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
  // The GitHub issue sync (task 7fc83592): id is the link, name the repo,
  // ownerId the owner who made the link.
  "github_sync",
  // The updater (scripts/update.sh), for each finished update attempt
  // (operation office.update). The server writes the entry from the
  // updater's progress record.
  "updater",
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
  // The office, room, agent or member prompt after the write; "" when cleared.
  promptContent?: string;
  // secrets.use: the request that got the value. The path has no query.
  secretUse?: { host: string; method: string; path: string };
  // terminal.open and terminal.join of a recorded terminal: the recording.
  terminalRecording?: { id: string };
  // A write to a member's integrations (/api/users/:username/...): whose, and
  // the variable, secret or MCP server name. Never a value.
  member?: { userId: string; item?: string };
  // office.update: one finished update attempt.
  update?: UpdateAudit;
  // office.lockdown and office.unlock (task cdd7883d): why, as given.
  lockdown?: { reason: string };
}
export interface UpdateAudit {
  attempt: string;
  // The release tag the attempt went to.
  target: string;
  result: "ok" | "failed";
  // Epoch ms. ended is null when the updater died before it wrote a result.
  started: number;
  ended: number | null;
  // In the order the updater entered them. A phase lasts until the next one
  // starts; the last lasts until ended, and its seconds are null when ended
  // is null.
  phases: { phase: string; seconds: number | null }[];
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
