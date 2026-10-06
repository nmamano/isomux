// Where agent space and the share are (internal-docs/os-user-split-design.md,
// sections 3.1 and 3.1.2). In single-user mode both are STATE_ROOT and nothing
// moves. In split mode they come from STATE_ROOT/split.json, read once at
// import like STATE_ROOT itself (server/config.ts). A missing or bad
// split.json leaves the single-user values here; the split start then refuses
// to start the office (server/split/start.ts).

import { readFileSync } from "fs";
import { join } from "path";
import { IS_DEFAULT_STATE_ROOT, STATE_ROOT } from "../config.ts";

// STATE_ROOT/split.json, written by the migration (design section 3.1).
export interface SplitConfig {
  agentUser: string;
  agentUid: number;
  agentRoot: string;
  agentRootWasDefault: boolean;
  shareRoot: string;
}

export function readSplitConfig(stateRoot: string): SplitConfig {
  const raw = JSON.parse(
    readFileSync(join(stateRoot, "split.json"), "utf8"),
  ) as Partial<SplitConfig>;
  if (
    typeof raw.agentUser !== "string" ||
    !raw.agentUser ||
    typeof raw.agentUid !== "number" ||
    !Number.isSafeInteger(raw.agentUid) ||
    typeof raw.agentRoot !== "string" ||
    !raw.agentRoot.startsWith("/") ||
    typeof raw.agentRootWasDefault !== "boolean" ||
    typeof raw.shareRoot !== "string" ||
    !raw.shareRoot.startsWith("/")
  )
    throw new Error("split.json is incomplete");
  return raw as SplitConfig;
}

export function splitRequested(env: NodeJS.ProcessEnv): boolean {
  return (
    Boolean(env.ISOMUX_AGENT_RUNNER?.trim()) && env.ISOMUX_SPLIT_RIG === "1"
  );
}

export interface Roots {
  // split.json in split mode, else null.
  split: SplitConfig | null;
  agentRoot: string;
  agentRootIsDefault: boolean;
  shareRoot: string;
}

export function resolveRoots(
  env: NodeJS.ProcessEnv,
  stateRoot: string,
  stateRootIsDefault: boolean,
): Roots {
  let split: SplitConfig | null = null;
  if (splitRequested(env))
    try {
      split = readSplitConfig(stateRoot);
    } catch {}
  return {
    split,
    agentRoot: split?.agentRoot ?? stateRoot,
    agentRootIsDefault: split?.agentRootWasDefault ?? stateRootIsDefault,
    shareRoot: split?.shareRoot ?? stateRoot,
  };
}

const ROOTS = resolveRoots(process.env, STATE_ROOT, IS_DEFAULT_STATE_ROOT);

export const SPLIT_CONFIG = ROOTS.split;
// The old state root on a migrated install: provider homes, codex-home,
// OpenCode profiles and the other agent-space subtrees stay there.
export const AGENT_ROOT = ROOTS.agentRoot;
export const AGENT_ROOT_IS_DEFAULT = ROOTS.agentRootIsDefault;
// Files the server writes and the agent user reads, runs or connects to.
export const SHARE_ROOT = ROOTS.shareRoot;

// The path a state file had before the migration: the identities in design
// section 3.1.2 hash these, so they stay the same across the move.
export function logicalAgentPath(path: string): string {
  if (!SPLIT_CONFIG) return path;
  const prefix = `${STATE_ROOT}/`;
  return path.startsWith(prefix)
    ? join(AGENT_ROOT, path.slice(prefix.length))
    : path;
}
