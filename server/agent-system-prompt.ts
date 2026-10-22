import type {
  AgentInfo,
  OfficeSettings,
  RoomWire,
  UserRecord,
} from "../shared/types.ts";
import { memoryStore } from "./memory-store.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { getUserById, getUserByName } from "./users.ts";

// The agent's manager, for the system prompt. Found by userId, so a member's
// rename keeps their name, special instructions and memory label current. The
// `manager` name snapshot is used only for a legacy agent with no userId.
export function managerOf(agent: Pick<AgentInfo, "userId" | "manager">): {
  record: UserRecord | undefined;
  name: string | null;
} {
  const record = agent.userId
    ? getUserById(agent.userId)
    : getUserByName(agent.manager);
  return { record, name: record?.name ?? agent.manager };
}

/** Build the exact system prompt used for the agent's next conversation. */
export function buildAgentSystemPrompt(
  agent: Pick<
    AgentInfo,
    | "name"
    | "id"
    | "roomId"
    | "manager"
    | "userId"
    | "customInstructions"
    | "privileged"
    | "agentType"
  >,
  room: RoomWire,
  officeConfig: OfficeSettings,
  agentMemory?: string,
): string {
  const manager = managerOf(agent);
  return buildSystemPrompt(
    agent.name,
    agent.id,
    room.name,
    room.id,
    officeConfig.prompt,
    room.prompt,
    agent.customInstructions,
    manager.name,
    manager.record?.memberPrompt ?? null,
    agent.privileged ?? false,
    [
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
                scope: "member" as const,
                scopeId: agent.userId,
                label: `Member "${manager.name ?? "member"}"`,
              },
            ]
          : []),
      ]),
      (() => {
        const body =
          agentMemory === undefined
            ? memoryStore.renderForPrompt("agent", agent.id)
            : agentMemory
                .split("\n")
                .filter((line) => line.trim() !== "")
                .join("\n");
        return body ? `Your agent:\n${body}` : null;
      })(),
    ]
      .filter(Boolean)
      .join("\n\n") || null,
    agent.agentType,
    manager.record?.language ?? null,
  );
}
