import type { AgentInfo, OfficeSettings, RoomWire } from "../shared/types.ts";
import { memoryStore } from "./memory-store.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { getUserByName } from "./users.ts";

/** Build the exact system prompt used for the agent's next conversation. */
export function buildAgentSystemPrompt(
  agent: AgentInfo,
  room: RoomWire,
  officeConfig: OfficeSettings,
): string {
  const ownerRecord = agent.username
    ? getUserByName(agent.username)
    : undefined;
  return buildSystemPrompt(
    agent.name,
    agent.id,
    room.name,
    room.id,
    officeConfig.prompt,
    room.prompt,
    agent.customInstructions,
    agent.username,
    ownerRecord?.memberPrompt ?? null,
    agent.privileged ?? false,
    memoryStore.renderForPromptMulti([
      { scope: "office", scopeId: null, label: "Office-wide" },
      ...(room.type === "lobby"
        ? []
        : [
            {
              scope: "room" as const,
              scopeId: agent.roomId,
              label: `Room "${room.name}"`,
            },
          ]),
      ...(agent.userId
        ? [
            {
              scope: "boss" as const,
              scopeId: agent.userId,
              label: `Member "${agent.username ?? "member"}"`,
            },
          ]
        : []),
      { scope: "agent", scopeId: agent.id, label: "Your agent" },
    ]),
    agent.agentType,
    ownerRecord?.language ?? null,
  );
}
