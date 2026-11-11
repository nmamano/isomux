import type { AgentInfo } from "../../shared/types.ts";

/** A room tab's dot: green while any agent of the room works, never on the
 *  active room's own tab. Unread output lights no dot (Nil, task 89d17270). */
export function roomActivityDotColor(
  roomAgents: readonly AgentInfo[],
  isActive: boolean,
): "var(--green)" | null {
  if (isActive) return null;
  const hasWorkingAgent = roomAgents.some(
    (agent) => agent.state === "thinking" || agent.state === "tool_executing",
  );
  return hasWorkingAgent ? "var(--green)" : null;
}
