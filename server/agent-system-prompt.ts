import type {
  AgentInfo,
  OfficeSettings,
  RoomWire,
  UserRecord,
} from "../shared/types.ts";
import { memoryStore } from "./memory-store.ts";
import { agentAccessOf } from "../shared/agent-access.ts";
import { agentMakesSchedules } from "./cron-agent-limits.ts";
import { buildSystemPrompt, managerHiddenLine } from "./system-prompt.ts";
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

/**
 * Build the exact system prompt used the next time the agent's session starts.
 * hideManager puts managerHiddenLine in place of the manager's special
 * instructions and member memory, for a caller that may not read them.
 */
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
    | "access"
    | "agentType"
    | "permissionMode"
    | "codexSandbox"
  >,
  room: RoomWire,
  officeConfig: OfficeSettings,
  agentMemory?: string,
  hideManager = false,
): string {
  const manager = managerOf(agent);
  const managerLabel = `Member "${manager.name ?? "member"}"`;
  const hiddenLine = managerHiddenLine(manager.name ?? "member");
  const memberPrompt = manager.record?.memberPrompt ?? null;
  const memberMemory =
    hideManager &&
    agent.userId &&
    memoryStore.renderForPrompt("member", agent.userId)
      ? `${managerLabel}:\n${hiddenLine}`
      : null;
  return buildSystemPrompt(
    agent.name,
    agent.id,
    room.name,
    room.id,
    officeConfig.prompt,
    room.prompt,
    agent.customInstructions,
    manager.name,
    memberPrompt && hideManager ? hiddenLine : memberPrompt,
    agentAccessOf(agent),
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
        ...(agent.userId && !hideManager
          ? [
              {
                scope: "member" as const,
                scopeId: agent.userId,
                label: managerLabel,
              },
            ]
          : []),
      ]),
      memberMemory,
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
    agentMakesSchedules(agent),
  );
}
