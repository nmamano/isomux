// The folder confinement of a Codex session at the folder and web stops, as
// its safety hook reads it (task 25015e41). The session sets
// CODEX_CONFINE_ENV in the app-server's environment, and Codex runs the hook
// with that environment. The hook is built from it (safety-hook-build.ts):
// its imports beyond what the hook already loads (safety-policy.ts) go into
// the hook too.

import { isAbsolute } from "path";
import type { AgentAccess } from "../../../shared/agent-access.ts";
import {
  FOLDER_FILES_MCP_SERVER,
  FOLDER_FILES_TOOLS,
} from "../../folder-files.ts";

// The office MCP server's name in an agent's session (agent-manager.ts).
const OFFICE_MCP_SERVER = "isomux";

export const CODEX_CONFINE_ENV = "ISOMUX_CODEX_CONFINE";

export interface CodexConfine {
  access: AgentAccess;
  folder: string;
  // The exact tool names the session allows, as the hook sees them, lower
  // case (FolderConfinement.tools).
  tools: string[];
}

// The tool name the hook sees for MCP tool `tool` of server `server`.
export function codexHookMcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

// The tools of a session at the folder or web stop, as the hook sees them:
// apply_patch, request_user_input, the isomux_files tools and `officeTools`
// (the office MCP server's tool names for the agent's token).
export function codexConfinedTools(officeTools: string[]): string[] {
  return [
    "apply_patch",
    "request_user_input",
    ...FOLDER_FILES_TOOLS.map((tool) =>
      codexHookMcpToolName(FOLDER_FILES_MCP_SERVER, tool),
    ),
    ...officeTools.map((tool) => codexHookMcpToolName(OFFICE_MCP_SERVER, tool)),
  ].map((name) => name.toLowerCase());
}

// The variable's value for `confine`.
export function codexConfineEnvValue(confine: CodexConfine): string {
  return JSON.stringify(confine);
}

function unreadable(): Error {
  return new Error(`${CODEX_CONFINE_ENV} cannot be read`);
}

// The confinement in `env`: null when the variable is not set. Throws when it
// is set but cannot be read; the hook then denies every call.
export function readCodexConfine(
  env: Record<string, string | undefined>,
): CodexConfine | null {
  const value = env[CODEX_CONFINE_ENV];
  if (value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw unreadable();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw unreadable();
  const { access, folder, tools } = parsed as Record<string, unknown>;
  if (
    (access !== "folder" && access !== "web") ||
    typeof folder !== "string" ||
    !isAbsolute(folder) ||
    !Array.isArray(tools) ||
    !tools.every((tool) => typeof tool === "string")
  )
    throw unreadable();
  return { access, folder, tools };
}
