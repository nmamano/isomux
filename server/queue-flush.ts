// The flush state of an agent's message queue (ManagedAgent.flush): the
// running flush, if any, and the holds that keep the queue from flushing.
// requestFlush (agent-manager.ts) is the one entry point that starts a flush;
// these helpers only read and change the state.

import type { ManagedAgent } from "./internal-types.ts";

// Why the queue is held. "conversation": a conversation change swaps
// sessions and rewrites the chat, so nothing consumes the queue until the
// next session can take it (one hold per change). "backend": a send failed
// for a missing or signed-out backend, so the flush does not retry in a
// loop; the next message releases it (at most one).
export type QueueHoldReason = "conversation" | "backend";

// One flush. Only that flush's own finally clears it from FlushState.running.
export interface FlushRun {
  // Date.now() when the flush started. The queue watchdog ages a running
  // flush by it.
  startedAt: number;
  // A trigger asked for a flush while this one ran: the finally starts
  // another.
  rerun: boolean;
  // The turn this flush starts carries a wake after a server restart
  // (server/restart-wake.ts). recordTurnStart reads and clears it.
  restartWake: boolean;
}

export interface FlushState {
  running: FlushRun | null;
  holds: Map<symbol, QueueHoldReason>;
}

export function newFlushState(): FlushState {
  return { running: null, holds: new Map() };
}

export function flushRunning(managed: ManagedAgent): boolean {
  return managed.flush.running !== null;
}

export function queueHeld(managed: ManagedAgent): boolean {
  return managed.flush.holds.size > 0;
}

// A conversation change's hold. The caller releases it with releaseHold.
export function holdQueue(managed: ManagedAgent): symbol {
  const hold = Symbol("queue-hold");
  managed.flush.holds.set(hold, "conversation");
  return hold;
}

// The backend hold. Idempotent: at most one.
export function holdBackend(managed: ManagedAgent): void {
  if (hasBackendHold(managed)) return;
  managed.flush.holds.set(Symbol("backend-hold"), "backend");
}

export function hasBackendHold(managed: ManagedAgent): boolean {
  for (const reason of managed.flush.holds.values())
    if (reason === "backend") return true;
  return false;
}

// Removes one hold. The caller then calls requestFlush, which owns the
// "still held" guard.
export function releaseHold(managed: ManagedAgent, hold: symbol): void {
  managed.flush.holds.delete(hold);
}

// Removes the backend hold, if any. A release then calls requestFlush; a
// conversation change that carries the queue itself does not.
export function dropBackendHold(managed: ManagedAgent): void {
  for (const [hold, reason] of managed.flush.holds)
    if (reason === "backend") managed.flush.holds.delete(hold);
}
