// Codex at the access stops below standard: chat and office only. The thread
// gets no file, shell, web or agent tools, a read-only sandbox without
// network, an empty folder the server makes, and no MCP server, skill or
// project doc of the member's except the office MCP server at office.
// Measured on codex 0.164.0 with gpt-5.5 (task e77304b1); another version
// or model runs these stops only after a new probe
// (server/backends/codex-access.live.test.ts).

import { join } from "path";
import {
  belowStandard,
  CODEX_BELOW_STANDARD_MODELS,
  engineRunsAccess,
  stopHasFolder,
  type AgentAccess,
} from "../../../shared/agent-access.ts";
import { CODEX_EMPTY_CWD_ROOT } from "../empty-folder.ts";
import { makeEmptyFolder } from "../empty-folder-host.ts";
import { getCodexPinnedVersion } from "./native-bin.ts";

// The Codex version the probe ran on. getCodexPinnedVersion() must equal it.
export const CODEX_BELOW_STANDARD_PROVEN_VERSION = "0.164.0";

// Every feature of Codex 0.164.0 that adds a tool, a tool source or a way
// out. The ones from apps on add a tool only under a ChatGPT sign-in, which
// the live test cannot see, so they are named here.
const FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "goals",
  "multi_agent",
  "multi_agent_v2",
  "sleep_tool",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
  "memories",
  "request_permissions_tool",
  "code_mode",
  "code_mode_only",
  "standalone_web_search",
];

// The thread config keys Isomux sets at chat and office. Each one is set
// explicitly, so a member config.toml that turns a feature on loses key by
// key. skills.include_instructions hides the skill list on every turn, a
// skill added after the start included. No sandbox network key: the thread
// is read-only.
export const CODEX_BELOW_STANDARD_CONFIG: Readonly<Record<string, unknown>> = {
  ...Object.fromEntries(FEATURES_OFF.map((key) => [`features.${key}`, false])),
  web_search: "disabled",
  project_doc_max_bytes: 0,
  "skills.include_instructions": false,
  "memories.use_memories": false,
  "memories.generate_memories": false,
};

// Whether this server's Codex may run `access`: at a stop below standard,
// the pinned version is the proven one. The engine and model rule is
// engineRunsAccess.
export function codexRunsBelowStandard(access: AgentAccess): boolean {
  if (!belowStandard(access)) return true;
  return (
    !stopHasFolder(access) &&
    getCodexPinnedVersion() === CODEX_BELOW_STANDARD_PROVEN_VERSION
  );
}

// Why Codex with `model` may not run `access` on this server, else null.
export function codexBelowStandardRefusal(
  access: AgentAccess,
  model: string,
): string | null {
  if (!engineRunsAccess("codex", access, model))
    return `Codex runs an agent below Standard only at Chat or Office, with ${CODEX_BELOW_STANDARD_MODELS.join(" or ")}. Change the model or the access level.`;
  if (!codexRunsBelowStandard(access))
    return "This Codex version cannot run an agent below Standard yet. Move the agent to Standard, or use Claude.";
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The names of the MCP servers in a config/read result (the effective
// config, every layer merged). null: a shape this code cannot read. Codex
// sends an empty table when there is no server.
export function codexConfigMcpServerNames(result: unknown): string[] | null {
  if (!isPlainObject(result) || !isPlainObject(result.config)) return null;
  const servers = result.config.mcp_servers;
  return isPlainObject(servers) ? Object.keys(servers) : null;
}

// The SKILL.md paths in a skills/list result for one cwd. null: a shape this
// code cannot read, or no entry for the cwd. A skill in the entry's errors
// is ignored: Codex does not load it.
export function codexSkillPaths(result: unknown, cwd: string): string[] | null {
  if (!isPlainObject(result) || !Array.isArray(result.data)) return null;
  const entry: unknown = (result.data as unknown[]).find(
    (item) => isPlainObject(item) && item.cwd === cwd,
  );
  if (!isPlainObject(entry) || !Array.isArray(entry.skills)) return null;
  const paths: string[] = [];
  for (const skill of entry.skills as unknown[]) {
    if (!isPlainObject(skill) || typeof skill.path !== "string") return null;
    paths.push(skill.path);
  }
  return paths;
}

// The thread config at chat and office: CODEX_BELOW_STANDARD_CONFIG, every
// MCP server in `mcpServerNames` off except the ones in `keep`, and every
// skill in `skillPaths` off (a skill named in a message loads otherwise).
// The servers go as one nested table: Codex splits a dotted key at every
// dot, and a server name may hold one.
export function codexBelowStandardThreadConfig(
  mcpServerNames: string[],
  skillPaths: string[],
  keep: string[],
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...CODEX_BELOW_STANDARD_CONFIG };
  const off = mcpServerNames.filter((name) => !keep.includes(name));
  if (off.length > 0)
    config.mcp_servers = Object.fromEntries(
      off.map((name) => [name, { enabled: false }]),
    );
  if (skillPaths.length > 0)
    config["skills.config"] = skillPaths.map((path) => ({
      path,
      enabled: false,
    }));
  return config;
}

// The part of the app-server client discovery uses.
interface CodexRequester {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

// Asks the app-server for the member's MCP servers and skills as Codex sees
// them from `cwd`, and returns the thread config that turns them off (the
// servers in `keep` stay). Throws when either answer cannot be read.
export async function codexBelowStandardDiscovery(
  client: CodexRequester,
  cwd: string,
  keep: string[],
): Promise<Record<string, unknown>> {
  const fail = (detail: string) =>
    new Error(
      `Isomux could not check this agent's Codex MCP servers and skills (${detail}), so the agent did not start. Try again, or move the agent to Standard.`,
    );
  let names: string[] | null;
  try {
    names = codexConfigMcpServerNames(
      await client.request("config/read", { cwd, includeLayers: false }),
    );
  } catch (err) {
    throw fail(`config/read: ${(err as Error).message}`);
  }
  if (!names) throw fail("config/read gave an unknown answer");
  let paths: string[] | null;
  try {
    paths = codexSkillPaths(
      await client.request("skills/list", { cwds: [cwd], forceReload: true }),
      cwd,
    );
  } catch (err) {
    throw fail(`skills/list: ${(err as Error).message}`);
  }
  if (!paths) throw fail("skills/list gave an unknown answer");
  return codexBelowStandardThreadConfig(names, paths, keep);
}

// The parent of the empty folders, in agent space (split mode).
export { CODEX_EMPTY_CWD_ROOT };

// The empty folder a thread below standard runs in,
// CODEX_EMPTY_CWD_ROOT/<agentId>: made for the agent by the server in agent
// space, mode 0700, outside the agent's own data. Throws when it holds
// anything.
export async function codexEmptyCwd(agentId: string): Promise<string> {
  return makeEmptyFolder(join(CODEX_EMPTY_CWD_ROOT, agentId));
}
