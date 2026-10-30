// The limits on an agent that another agent spawns (task eb98cff1). Every
// agent spawns into its manager's rooms (agent:spawn). An agent without
// agent:manage below full reach spawns no agent that reaches more than itself,
// in permission mode or in folder. Every agent's spawn counts against its
// spawn tree, a sanity limit for a loop of agents that spawn agents.

import { realpathSync } from "fs";
import { CODEX_DEFAULT_SANDBOX, type AgentInfo } from "../shared/types.ts";
import { folderInside } from "./cron-agent-limits.ts";

// Live agents in one spawn tree, its root not counted.
export const SPAWN_TREE_LIMIT = 50;

// The API error codes of the two refusals.
export const SPAWN_EXCEEDS_AGENT = "spawn_exceeds_agent";
export const SPAWN_LIMIT = "spawn_limit";

export type SpawnLimitAgent = Pick<
  AgentInfo,
  "agentType" | "permissionMode" | "codexSandbox" | "cwd"
>;

type SpawnTree = Pick<AgentInfo, "spawnedByAgentId" | "spawnRootAgentId">;

// The spawn-tree fields of a record, without empty keys: for the persisted
// agent, the killed-agent snapshot and the restore.
export function spawnTreeFields(record: SpawnTree): SpawnTree {
  return {
    ...(record.spawnedByAgentId
      ? { spawnedByAgentId: record.spawnedByAgentId }
      : {}),
    ...(record.spawnRootAgentId
      ? { spawnRootAgentId: record.spawnRootAgentId }
      : {}),
  };
}

// The tree of an agent that `spawner` spawns.
export function childSpawnTree(spawner: Pick<AgentInfo, "id"> & SpawnTree) {
  return {
    spawnedByAgentId: spawner.id,
    spawnRootAgentId: spawner.spawnRootAgentId ?? spawner.id,
  };
}

// Each list goes from the strictest value to the loosest.
const CLAUDE_MODES = ["default", "acceptEdits", "auto", "bypassPermissions"];
const OPENCODE_MODES = ["default", "bypassPermissions"];
const CODEX_APPROVALS = ["untrusted", "on-request", "never"];
const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

// A value not in the list counts as the loosest for the child and as the
// strictest for the spawner, so an unknown value never lets a child through.
function rank(
  order: readonly string[],
  value: string | undefined,
  unknown: "loosest" | "strictest",
): number {
  const i = value === undefined ? -1 : order.indexOf(value);
  if (i !== -1) return i;
  return unknown === "loosest" ? order.length : -1;
}

type Mode = Pick<AgentInfo, "agentType" | "permissionMode" | "codexSandbox">;

const sandboxOf = (agent: Mode) => agent.codexSandbox ?? CODEX_DEFAULT_SANDBOX;

// Full access without approvals: nothing a child can exceed.
export function hasFullReach(agent: Mode): boolean {
  if (agent.agentType === "codex")
    return (
      agent.permissionMode === "never" &&
      sandboxOf(agent) === "danger-full-access"
    );
  return agent.permissionMode === "bypassPermissions";
}

// Same engine: no axis looser than the spawner's. Another engine: only that
// engine's strictest mode.
function modeWithin(child: Mode, spawner: Mode): boolean {
  const same = child.agentType === spawner.agentType;
  if (child.agentType === "codex")
    return same
      ? rank(CODEX_APPROVALS, child.permissionMode, "loosest") <=
          rank(CODEX_APPROVALS, spawner.permissionMode, "strictest") &&
          rank(CODEX_SANDBOXES, sandboxOf(child), "loosest") <=
            rank(CODEX_SANDBOXES, sandboxOf(spawner), "strictest")
      : child.permissionMode === "untrusted" &&
          sandboxOf(child) === "read-only";
  const order = child.agentType === "opencode" ? OPENCODE_MODES : CLAUDE_MODES;
  return same
    ? rank(order, child.permissionMode, "loosest") <=
        rank(order, spawner.permissionMode, "strictest")
    : child.permissionMode === "default";
}

// The refusal reason when the child, with its RESOLVED mode and sandbox,
// reaches more than the spawner, else null.
export function spawnExceedsAgent(
  child: SpawnLimitAgent,
  spawner: SpawnLimitAgent,
  realpath: (path: string) => string = realpathSync,
): string | null {
  if (hasFullReach(spawner)) return null;
  if (!modeWithin(child, spawner))
    return "An agent you spawn cannot have more permissions than you. Use your engine with your mode or a stricter one, or another engine in its strictest mode: permissionMode default for Claude and OpenCode, untrusted with codexSandbox read-only for Codex.";
  if (!folderInside(child.cwd, spawner.cwd, realpath))
    return "An agent you spawn must work in your working folder or a folder inside it.";
  return null;
}
