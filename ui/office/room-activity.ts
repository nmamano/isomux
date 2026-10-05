import type { AgentInfo } from "../../shared/types.ts";

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
