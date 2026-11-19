import type { AgentInfo } from "../../shared/types.ts";

/** A room tab's dot: green while any agent of the room works, else the
 *  accent while the room's chat has unread posts (task 5b055cf3); never on
 *  the active room's own tab. Unread agent output lights no dot (Nil, task
 *  89d17270). */
export function roomActivityDotColor(
  roomAgents: readonly AgentInfo[],
  isActive: boolean,
  chatUnread = 0,
): "var(--green)" | "var(--accent)" | null {
  if (isActive) return null;
  const hasWorkingAgent = roomAgents.some(
    (agent) => agent.state === "thinking" || agent.state === "tool_executing",
  );
  if (hasWorkingAgent) return "var(--green)";
  return chatUnread > 0 ? "var(--accent)" : null;
}
