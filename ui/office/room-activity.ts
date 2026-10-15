import type { AgentInfo } from "../../shared/types.ts";
import { isBackSeat } from "../../shared/desks.ts";

/** A front agent has unread output. A back agent's unread lights no room
 *  dot: people rarely talk to the back room (Nil, task f0af4677). */
export function roomHasUnread(
  roomAgents: readonly AgentInfo[],
  needsAttention: ReadonlySet<string>,
): boolean {
  return roomAgents.some(
    (a) => !isBackSeat(a.desk) && needsAttention.has(a.id),
  );
}

export function roomActivityDotColor(
  roomAgents: AgentInfo[],
  hasAttention: boolean,
  isActive: boolean,
): "var(--green)" | "var(--purple)" | null {
  if (isActive) return null;
  const hasWorkingAgent = roomAgents.some(
    (agent) => agent.state === "thinking" || agent.state === "tool_executing",
  );
  if (hasWorkingAgent) return "var(--green)";
  return hasAttention ? "var(--purple)" : null;
}
