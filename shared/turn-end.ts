// When an agent's turn ends, for the turn-end sound (ui/store.tsx) and the
// turn-end push (server/web-push-delivery.ts).

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

// The turn ends that sound the turn-end sound and send the turn-end push:
// the turn had human input, so traffic between agents stays quiet. `prev`
// is the agent before the change.
export function turnEndNotifies(
  prev: { state: string; turnHadHumanInput?: boolean } | undefined,
  next: string | undefined,
): boolean {
  return (
    prev !== undefined &&
    prev.turnHadHumanInput === true &&
    endsTurn(prev.state, next)
  );
}
