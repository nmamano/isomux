// Member-send outbox (task 51de8814). A message leaves the composer only once
// it is recorded here as a pending attempt, and the attempt stays until the
// server acknowledges it. A failed attempt stays as its own record, with its
// original text, attachments and id, until the member resends, edits or
// discards it. Resend reuses the id, so the server can tell a resend of an
// accepted attempt from a new message. Cronjob run chats use the same outbox
// (task 44872c41).
//
// Module state, not component state: an attempt in flight must settle even
// when its chat is closed. Each attempt is written to its own localStorage key
// (like the drafts in ui/view-persistence.ts) so it survives a reload and a
// second tab never overwrites it.

import { useSyncExternalStore } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type { Attachment } from "../../shared/types.ts";

export type OutboxError =
  // The request did not get an answer (network down, connection reset).
  | { kind: "network" }
  // The page reloaded while the attempt was in flight, so its outcome is
  // unknown. Resending is safe while the server still remembers the id.
  | { kind: "interrupted" }
  // The server answered with an error; `message` is its text.
  | { kind: "server"; message: string };

export interface OutboxAttempt {
  id: string; // also the clientMessageId sent to the server
  // The chat the attempt belongs to: the agent id, or for a cronjob run its
  // stream id (cronjobRunStreamId).
  agentId: string;
  // Set for a cronjob run chat: the attempt posts to the run's messages route.
  cronRun?: { jobId: string; runId: string };
  text: string;
  attachments?: Attachment[];
  device?: string;
  sendNow?: boolean;
  status: "pending" | "failed";
  error?: OutboxError;
  createdAt: number;
}

const KEY_PREFIX = "isomux-outbox:";

let attempts: OutboxAttempt[] = [];
let storageUser: string | null = null;
const listeners = new Set<() => void>();
// Cached per-agent views so useSyncExternalStore sees a stable snapshot.
let byAgentCache = new Map<string, OutboxAttempt[]>();
const EMPTY: OutboxAttempt[] = [];

function userPrefix(user: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(user.toLowerCase())}:`;
}

// False when the browser refused the write (quota, privacy mode). Before the
// member is known (and in the demo, which never restores) there is nothing to
// write to, and the attempt lives in memory only.
function persist(attempt: OutboxAttempt): boolean {
  if (!storageUser || typeof localStorage === "undefined") return true;
  try {
    localStorage.setItem(
      userPrefix(storageUser) + attempt.id,
      JSON.stringify(attempt),
    );
    return true;
  } catch {
    return false;
  }
}

function unpersist(id: string) {
  if (!storageUser || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(userPrefix(storageUser) + id);
  } catch {
    // Best-effort.
  }
}

function commit(next: OutboxAttempt[]) {
  attempts = next;
  byAgentCache = new Map();
  for (const listener of listeners) listener();
}

function update(id: string, patch: Partial<OutboxAttempt>) {
  const index = attempts.findIndex((a) => a.id === id);
  if (index < 0) return;
  const changed = { ...attempts[index], ...patch };
  persist(changed);
  commit(attempts.map((a, i) => (i === index ? changed : a)));
}

function remove(id: string) {
  if (!attempts.some((a) => a.id === id)) return;
  unpersist(id);
  commit(attempts.filter((a) => a.id !== id));
}

function parseAttempt(raw: string | null): OutboxAttempt | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<OutboxAttempt>;
    if (
      typeof v.id !== "string" ||
      typeof v.agentId !== "string" ||
      typeof v.text !== "string" ||
      (v.attachments !== undefined && !Array.isArray(v.attachments))
    )
      return null;
    const cronRun =
      typeof v.cronRun?.jobId === "string" &&
      typeof v.cronRun.runId === "string"
        ? { jobId: v.cronRun.jobId, runId: v.cronRun.runId }
        : undefined;
    return {
      id: v.id,
      agentId: v.agentId,
      ...(cronRun ? { cronRun } : {}),
      text: v.text,
      ...(v.attachments ? { attachments: v.attachments } : {}),
      ...(typeof v.device === "string" ? { device: v.device } : {}),
      ...(v.sendNow === true ? { sendNow: true } : {}),
      // Whatever it was before the reload, its outcome is not known now.
      status: "failed",
      error:
        v.status === "pending"
          ? { kind: "interrupted" }
          : (v.error ?? { kind: "interrupted" }),
      createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
    };
  } catch {
    return null;
  }
}

// Load `user`'s saved attempts for the agents that still exist and drop the
// keys of agents that do not (as the drafts are pruned). A cronjob run attempt
// is always kept: runs are never deleted. Called once the office knows who the
// member is and which agents they can see.
export function restoreOutbox(
  user: string,
  liveAgentIds: ReadonlySet<string>,
): void {
  storageUser = user;
  if (typeof localStorage === "undefined") return;
  const prefix = userPrefix(user);
  const restored: OutboxAttempt[] = [];
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const attempt = parseAttempt(localStorage.getItem(key));
      if (
        !attempt ||
        (!attempt.cronRun && !liveAgentIds.has(attempt.agentId))
      ) {
        localStorage.removeItem(key);
        continue;
      }
      // An attempt this tab is already tracking keeps its live state.
      if (!attempts.some((a) => a.id === attempt.id)) restored.push(attempt);
    }
  } catch {
    return;
  }
  // Attempts sent before the member was known get their keys now.
  for (const a of attempts) persist(a);
  restored.sort((a, b) => a.createdAt - b.createdAt);
  commit([...restored, ...attempts]);
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function request(attempt: OutboxAttempt): Promise<unknown> {
  const device = attempt.device ? { device: attempt.device } : {};
  if (attempt.cronRun) {
    const { jobId, runId } = attempt.cronRun;
    return apiFetch(
      "POST",
      `/api/cronjobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(
        runId,
      )}/messages`,
      { text: attempt.text, clientMessageId: attempt.id, ...device },
    );
  }
  return apiFetch("POST", `/api/agents/${attempt.agentId}/messages`, {
    text: attempt.text,
    clientMessageId: attempt.id,
    ...device,
    ...(attempt.attachments ? { attachments: attempt.attachments } : {}),
    ...(attempt.sendNow ? { sendNow: true } : {}),
  });
}

function post(attempt: OutboxAttempt) {
  request(attempt).then(
    () => remove(attempt.id),
    (err: unknown) => {
      // A discarded or edited attempt is gone; nothing to mark.
      if (!attempts.some((a) => a.id === attempt.id)) return;
      update(attempt.id, {
        status: "failed",
        error:
          err instanceof ApiError
            ? { kind: "server", message: err.message }
            : { kind: "network" },
      });
    },
  );
}

// Record a new attempt as pending and send it. The caller clears the composer
// after this returns an attempt. It returns null, and sends nothing, when the
// browser cannot save the attempt: the composer is then the only copy.
export function sendAttempt(input: {
  agentId: string;
  cronRun?: { jobId: string; runId: string };
  text: string;
  attachments?: Attachment[];
  device?: string;
  sendNow?: boolean;
}): OutboxAttempt | null {
  const attempt: OutboxAttempt = {
    id: newId(),
    agentId: input.agentId,
    ...(input.cronRun ? { cronRun: input.cronRun } : {}),
    text: input.text,
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    ...(input.device ? { device: input.device } : {}),
    ...(input.sendNow ? { sendNow: true } : {}),
    status: "pending",
    createdAt: Date.now(),
  };
  if (!persist(attempt)) return null;
  commit([...attempts, attempt]);
  post(attempt);
  return attempt;
}

// Send a failed attempt again with its original id and payload.
export function resendAttempt(id: string): void {
  const attempt = attempts.find((a) => a.id === id);
  if (!attempt || attempt.status === "pending") return;
  update(id, { status: "pending", error: undefined });
  post(attempt);
}

export function discardAttempt(id: string): void {
  remove(id);
}

// Drop the attempt and hand back its payload, for the composer to take as a
// new draft.
export function takeAttempt(id: string): OutboxAttempt | null {
  const attempt = attempts.find((a) => a.id === id) ?? null;
  if (attempt) remove(id);
  return attempt;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function outboxFor(agentId: string): OutboxAttempt[] {
  let list = byAgentCache.get(agentId);
  if (!list) {
    const filtered = attempts.filter((a) => a.agentId === agentId);
    list = filtered.length > 0 ? filtered : EMPTY;
    byAgentCache.set(agentId, list);
  }
  return list;
}

export function useOutbox(agentId: string): OutboxAttempt[] {
  return useSyncExternalStore(
    subscribe,
    () => outboxFor(agentId),
    () => EMPTY,
  );
}

// Tests only: forget every attempt and the member.
export function _resetOutboxForTests(): void {
  attempts = [];
  storageUser = null;
  byAgentCache = new Map();
}
