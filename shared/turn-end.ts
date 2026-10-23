// When an agent's turn ends and whom it notifies, for the Unread badge and
// turn-end sound (ui/store.tsx) and the turn-end push
// (server/web-push-delivery.ts).

import type { AgentState } from "./types.ts";

// States where the agent waits for a person.
export const ATTENTION_STATES: ReadonlySet<string> = new Set<AgentState>([
  "idle",
  "error",
  "waiting_for_response",
]);

// A turn ends when the agent goes from working to an attention state.
export function endsTurn(
  prev: string | undefined,
  next: string | undefined,
): boolean {
  return (
    prev !== undefined &&
    next !== undefined &&
    !ATTENTION_STATES.has(prev) &&
    ATTENTION_STATES.has(next)
  );
}

// The members a turn end notifies (Unread badge, turn-end sound, turn-end
// push): the members who started the turn, when the change ends it. `prev`
// is the agent before the change.
export function turnEndMembers(
  prev: { state: string; turnMemberIds?: readonly string[] } | undefined,
  next: string | undefined,
): readonly string[] {
  if (prev === undefined || !endsTurn(prev.state, next)) return [];
  return prev.turnMemberIds ?? [];
}
