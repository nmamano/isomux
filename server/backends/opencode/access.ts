// OpenCode at the access stops below standard (task e77304b1, merge C2).
// A session below standard runs on its own OpenCode server per member,
// started with project config off (OPENCODE_DISABLE_PROJECT_CONFIG), on its
// own profile. It runs as one of four Isomux agents whose rules deny every
// tool and allow the stop's tools by exact name; the session gets the same
// list at create and at every agent switch. The safety plugin refuses any
// tool call not in the session's exact list. Measured on OpenCode 2.1.4; a
// new version runs these stops only after a new probe
// (server/backends/opencode-access.live.test.ts).

import { join } from "node:path";
import {
  belowStandard,
  type AgentAccess,
} from "../../../shared/agent-access.ts";
import { OPENCODE_EMPTY_CWD_ROOT } from "../empty-folder.ts";
import { makeEmptyFolder } from "../empty-folder-host.ts";
import { OPENCODE_CLI_VERSION } from "./runtime.ts";
export {
  OPENCODE_OFFICE_MCP_SERVER,
  OPENCODE_STOP_AGENTS,
  openCodeAgentStop,
  openCodeAllowedTools,
  openCodeStopAgent,
  openCodeStopAgentRules,
  openCodeStopRules,
} from "./stop-rules.ts";
import { OPENCODE_OFFICE_MCP_SERVER } from "./stop-rules.ts";

// The OpenCode version the probe ran on. OPENCODE_CLI_VERSION must equal it.
export const OPENCODE_BELOW_STANDARD_PROVEN_VERSION = "2.1.4";

// The variables the limited server starts with on top of the member's
// launch env. 2.1.4 reads them once, at boot: per server, never per folder.
export const OPENCODE_LIMITED_SERVER_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
};

// The parent of the empty folders chat and office run in, in agent space.
export { OPENCODE_EMPTY_CWD_ROOT };

// The empty folder a one-shot below standard runs in.
export const OPENCODE_LIMITED_ONE_SHOT_DIR = join(
  OPENCODE_EMPTY_CWD_ROOT,
  "one-shot",
);

// Whether this server's OpenCode may run `access`: below standard, the
// pinned version is the proven one.
export function openCodeRunsBelowStandard(
  access: AgentAccess,
  version: string = OPENCODE_CLI_VERSION,
): boolean {
  return (
    !belowStandard(access) || version === OPENCODE_BELOW_STANDARD_PROVEN_VERSION
  );
}

// Why OpenCode may not run `access` on this server, else null.
export function openCodeBelowStandardRefusal(
  access: AgentAccess,
): string | null {
  return openCodeRunsBelowStandard(access)
    ? null
    : "This OpenCode version cannot run an agent below Standard yet. Move the agent to Standard, or use Claude.";
}

// The suffix of a member's limited profile key. A NUL cannot appear in a
// member key.
const LIMITED_KEY_SUFFIX = "\0below-standard";

// The key of the profile and server a session at `access` runs on: the
// member's key at standard and above (or no access), a derived key below.
export function openCodeProfileKey(
  environmentKey: string,
  access: AgentAccess | undefined,
): string {
  return access && belowStandard(access)
    ? `${environmentKey}${LIMITED_KEY_SUFFIX}`
    : environmentKey;
}

// The launch env of the server for `access`: the member's launch env, plus
// OPENCODE_LIMITED_SERVER_ENV below standard.
export function openCodeLaunchEnvFor(
  launchEnv: Record<string, string | undefined>,
  access: AgentAccess | undefined,
): Record<string, string | undefined> {
  return access && belowStandard(access)
    ? { ...launchEnv, ...OPENCODE_LIMITED_SERVER_ENV }
    : launchEnv;
}

// The empty folder of an agent at chat or office,
// OPENCODE_EMPTY_CWD_ROOT/<agentId>, made by the server in agent space.
// Throws when it holds anything.
export function openCodeEmptyCwd(agentId: string): Promise<string> {
  return makeEmptyFolder(join(OPENCODE_EMPTY_CWD_ROOT, agentId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The layers of a GET /api/config answer, or null for a shape this code
// cannot read: a list of {type: "document" | "directory", path?: string}.
interface ConfigLayer {
  type: "document" | "directory";
  path: string | undefined;
  info: unknown;
}
function configLayers(body: unknown): ConfigLayer[] | null {
  if (!Array.isArray(body)) return null;
  const layers: ConfigLayer[] = [];
  for (const entry of body as unknown[]) {
    if (!isRecord(entry)) return null;
    if (entry.type !== "document" && entry.type !== "directory") return null;
    if (
      entry.path !== undefined &&
      entry.path !== null &&
      typeof entry.path !== "string"
    )
      return null;
    layers.push({
      type: entry.type,
      path: typeof entry.path === "string" ? entry.path : undefined,
      info: entry.info,
    });
  }
  return layers;
}

const CONFIG_REFUSAL =
  "OpenCode loads settings from this agent's folder or a folder above it, so this turn did not run. Remove opencode.json and .opencode from those folders, or move the agent to Standard.";
const UNREADABLE_REFUSAL = (what: string) =>
  `Isomux could not check this agent's OpenCode ${what}, so this turn did not run. Try again, or move the agent to Standard.`;

// The /api/config check at each start and resume below standard: the folder
// may load only Isomux's own config, as its content document (no path) and
// its file in the profile (`isomuxConfigFile`, exact path), and the layers of
// the member's config dir (`memberConfigDir`, null when there is none). A
// refusal text, else null. An unknown shape is a refusal.
export function openCodeConfigLayersRefusal(
  configBody: unknown,
  memberConfigDir: string | null,
  isomuxConfigFile: string,
): string | null {
  const layers = configLayers(configBody);
  if (!layers) return UNREADABLE_REFUSAL("settings");
  let pathless = 0;
  for (const layer of layers) {
    if (layer.path === undefined) {
      if (layer.type !== "document") return UNREADABLE_REFUSAL("settings");
      pathless++;
      continue;
    }
    if (layer.type === "document" && layer.path === isomuxConfigFile) continue;
    const member =
      memberConfigDir !== null &&
      (layer.path === memberConfigDir ||
        (layer.type === "document" &&
          layer.path.startsWith(`${memberConfigDir}/`) &&
          !layer.path.slice(memberConfigDir.length + 1).includes("/")));
    if (!member) return CONFIG_REFUSAL;
  }
  return pathless === 1 ? null : UNREADABLE_REFUSAL("settings");
}

// A name that gives tools named like the office server's: "isomux" itself,
// or "isomux_<x>", whose tool "<t>" is "isomux_<x>_<t>".
function officeLike(name: string): boolean {
  return (
    name === OPENCODE_OFFICE_MCP_SERVER ||
    name.startsWith(`${OPENCODE_OFFICE_MCP_SERVER}_`)
  );
}

// The MCP check at each start and resume below standard: no server other
// than ours may be named "isomux" or start with "isomux_", in any config
// layer (configBody: GET /api/config) or added at run time (mcpBody: GET
// /api/mcp). ours: the servers Isomux added. A refusal text, else null. An
// unknown shape is a refusal.
export function openCodeMcpCollisionRefusal(
  configBody: unknown,
  mcpBody: unknown,
  ours: readonly string[],
): string | null {
  const layers = configLayers(configBody);
  if (!layers) return UNREADABLE_REFUSAL("MCP servers");
  const collision = (name: string) =>
    `The MCP server ${name} has a name like the office's own server, so this turn did not run. Rename or remove it, or move the agent to Standard.`;
  for (const layer of layers) {
    if (layer.type !== "document" || !isRecord(layer.info)) continue;
    const mcp = layer.info.mcp;
    if (mcp === undefined) continue;
    if (!isRecord(mcp)) return UNREADABLE_REFUSAL("MCP servers");
    const servers = mcp.servers;
    if (servers === undefined) continue;
    if (!isRecord(servers)) return UNREADABLE_REFUSAL("MCP servers");
    for (const name of Object.keys(servers))
      if (officeLike(name)) return collision(name);
  }
  if (!isRecord(mcpBody) || !Array.isArray(mcpBody.data))
    return UNREADABLE_REFUSAL("MCP servers");
  for (const row of mcpBody.data as unknown[]) {
    const name = isRecord(row) ? row.name : undefined;
    if (typeof name !== "string") return UNREADABLE_REFUSAL("MCP servers");
    if (officeLike(name) && !ours.includes(name)) return collision(name);
  }
  return null;
}
