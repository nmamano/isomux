// Messages a backend process accepted in a turn it has not ended
// (ManagedAgent.unsavedDelivery).
//
// A message leaves the durable queue when the process accepts it. If the
// process dies before the engine saves the turn (a restart a few seconds
// into a new session), the engine has no conversation to resume, and the
// office drops that session (pickAutoResumeSessionId). This record lets the
// drop put the messages back at the head of the queue, so the fresh session
// gets them.
//
// Lifetime: written when a send is accepted (runAgentTurn); cleared at every
// turn end the process reports (turn_completed, whatever its status) and at a
// Stop, which ends the turn on purpose; replaced when a send goes to another
// session. Keyed by the session's id, so a conversation change needs no
// clear of its own.

import type { QueuedMessage } from "../shared/types.ts";
import type { ManagedAgent } from "./internal-types.ts";

// The record as the message-queue store keeps it (field `unsaved` of the
// agent's record): the session object does not survive a restart.
export interface PersistedUnsavedDelivery {
  sessionId: string | null;
  items: QueuedMessage[];
}

// A send was accepted: its items join the record of the session they went
// to, or start a new record. True when the record changed.
export function recordUnsavedDelivery(
  managed: ManagedAgent,
  items: QueuedMessage[] | undefined,
): boolean {
  if (!items || items.length === 0) return false;
  const session = managed.sessionManager.session;
  const sessionId = managed.sessionManager.sessionId;
  const current = managed.unsavedDelivery;
  const copies = items.map((m) => ({ ...m }));
  if (
    current &&
    ((current.session !== null && current.session === session) ||
      (current.sessionId !== null && current.sessionId === sessionId))
  ) {
    current.items.push(...copies);
    if (current.sessionId === null) current.sessionId = sessionId;
    current.session = session;
    return true;
  }
  managed.unsavedDelivery = { sessionId, session, items: copies };
  return true;
}

// The session that accepted a record with no id reported its id. True when
// the record changed.
export function bindUnsavedSessionId(
  managed: ManagedAgent,
  sessionId: string,
): boolean {
  const current = managed.unsavedDelivery;
  if (
    !current ||
    current.sessionId !== null ||
    current.session === null ||
    current.session !== managed.sessionManager.session
  )
    return false;
  current.sessionId = sessionId;
  return true;
}

// The installed session ended its turn: the engine saved what it accepted.
// True when the record changed.
export function clearUnsavedDeliveryOnTurnEnd(managed: ManagedAgent): boolean {
  const current = managed.unsavedDelivery;
  if (!current) return false;
  const session = managed.sessionManager.session;
  const sessionId = managed.sessionManager.sessionId;
  const ours =
    (current.session !== null && current.session === session) ||
    (current.sessionId !== null && current.sessionId === sessionId);
  if (!ours) return false;
  managed.unsavedDelivery = null;
  return true;
}

// The record to send again when a session is dropped (`droppedId`) or
// replaced with no id (`droppedId` null): the record of that session, or a
// record whose process never reported an id. Null when there is none.
export function unsavedItemsToSendAgain(
  managed: ManagedAgent,
  droppedId: string | null,
): QueuedMessage[] | null {
  const current = managed.unsavedDelivery;
  if (!current) return null;
  if (current.sessionId !== null && current.sessionId !== droppedId)
    return null;
  return current.items;
}

// The items as they go back in the queue, without ids (the caller assigns
// them). Turns that continue a conversation (a restart wake, a resume after a
// usage limit, a continue on the office sign-in) are left out: the
// conversation they continue does not exist. Marks of the turn that carried
// them are cleared. `echoed`: the chat still shows the items, so their
// delivery writes no second entry.
export function cleanedForSendAgain(
  items: QueuedMessage[],
  echoed: boolean,
): Omit<QueuedMessage, "id">[] {
  const out: Omit<QueuedMessage, "id">[] = [];
  for (const item of items) {
    if (item.restartWake || item.limitResume || item.fallbackContinue) continue;
    const {
      id: _id,
      echoed: _echoed,
      steer: _steer,
      interruptCause: _interruptCause,
      queuedDuringBusyTurn: _busy,
      modelRetry: _modelRetry,
      ...rest
    } = item;
    out.push({ ...rest, ...(echoed ? { echoed: true } : {}) });
  }
  return out;
}
