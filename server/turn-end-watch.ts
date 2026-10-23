// Finds turn ends in the agent event stream for the turn-end push: the same
// rule as the browser's Unread badge and turn-end sound (ui/store.tsx,
// shared/turn-end.ts). A state change from working to an attention state
// notifies the members who started the turn.
//
// LEAF: the agent lookup and the hand-off are injected.

import type { AgentEvent } from "./internal-types.ts";
import { turnEndMembers } from "../shared/turn-end.ts";

export interface TurnEndAgent {
  id: string;
  name: string;
  roomId: string | null;
}

export function createTurnEndWatch(deps: {
  // The agent as it is now, or null when it is gone.
  agent: (
    agentId: string,
  ) => (TurnEndAgent & { turnMemberIds?: readonly string[] }) | null;
  onTurnEnd: (agent: TurnEndAgent & { memberIds: readonly string[] }) => void;
}) {
  // The last state seen per agent. An agent not seen yet has no turn to end.
  const last = new Map<string, string>();
  return {
    observe(event: AgentEvent): void {
      if (event.type === "agent_removed") {
        last.delete(event.agentId);
        return;
      }
      if (event.type !== "agent_updated") return;
      const next = event.changes.state;
      if (next === undefined) return;
      const prevState = last.get(event.agentId);
      last.set(event.agentId, next);
      if (prevState === undefined) return;
      const agent = deps.agent(event.agentId);
      if (!agent) return;
      // The update changed only the state, so the agent's members are the
      // ones it had before.
      const prev = { state: prevState, turnMemberIds: agent.turnMemberIds };
      const memberIds = turnEndMembers(prev, next);
      if (memberIds.length === 0) return;
      deps.onTurnEnd({
        id: agent.id,
        name: agent.name,
        roomId: agent.roomId,
        memberIds,
      });
    },
  };
}
