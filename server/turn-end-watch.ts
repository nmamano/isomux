// Finds turn ends in the agent event stream for the turn-end push: the same
// rule as the browser's turn-end sound (ui/store.tsx, shared/turn-end.ts). A
// state change from working to an attention state, in a turn that had human
// input.
//
// LEAF: the agent lookup and the hand-off are injected.

import type { AgentEvent } from "./internal-types.ts";
import { turnEndNotifies } from "../shared/turn-end.ts";

export interface TurnEndAgent {
  id: string;
  name: string;
  roomId: string | null;
}

export function createTurnEndWatch(deps: {
  // The agent as it is now, or null when it is gone.
  agent: (
    agentId: string,
  ) => (TurnEndAgent & { turnHadHumanInput?: boolean }) | null;
  onTurnEnd: (agent: TurnEndAgent) => void;
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
      // The update changed only the state, so the agent's flag is the one it
      // had before.
      const prev = {
        state: prevState,
        turnHadHumanInput: agent.turnHadHumanInput,
      };
      if (!turnEndNotifies(prev, next)) return;
      deps.onTurnEnd({ id: agent.id, name: agent.name, roomId: agent.roomId });
    },
  };
}
