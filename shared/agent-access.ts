// What an agent may use: one stop on the access slider. Each stop has
// everything the stop below it has. Below Standard the agent has no shell and
// reaches the office only through the office MCP server, with its token
// limited by a permission pack.

import {
  parseApiTokenLimits,
  type ApiTokenArea,
  type ApiTokenLimits,
} from "./api-token-limits.ts";

export const AGENT_ACCESS_STOPS = [
  // No tools and no office MCP server: the agent only answers in its chat.
  "chat",
  // The office MCP server with the pack, no engine file tools.
  "office",
  // Plus the file tools, inside the agent's folder only.
  "folder",
  // Plus the engine's web tool.
  "web",
  // The default agent: a shell and every engine tool.
  "standard",
  // Standard plus a curated set of its manager's capabilities.
  "privileged",
] as const;

export type AgentAccess = (typeof AGENT_ACCESS_STOPS)[number];

// A stop and its pack. The pack is present exactly at office, folder and web.
export interface AgentAccessGrant {
  access: AgentAccess;
  pack?: ApiTokenLimits;
}

// The stop of an agent record. A record from before the slider has only the
// privileged flag: true reads as privileged, false or absent as standard.
export function agentAccessOf(info: {
  access?: AgentAccess;
  privileged?: boolean;
}): AgentAccess {
  if (info.access) return info.access;
  return info.privileged ? "privileged" : "standard";
}

// Whether `access` has no shell (a stop below standard).
export function belowStandard(access: AgentAccess): boolean {
  return (
    AGENT_ACCESS_STOPS.indexOf(access) < AGENT_ACCESS_STOPS.indexOf("standard")
  );
}

// Whether `access` carries a pack.
export function stopHasPack(access: AgentAccess): boolean {
  return access === "office" || access === "folder" || access === "web";
}

// Whether `access` has the file tools, inside the agent's folder only.
export function stopHasFolder(access: AgentAccess): boolean {
  return access === "folder" || access === "web";
}

// Whether stop `upper` has everything stop `lower` has.
export function stopIncludes(upper: AgentAccess, lower: AgentAccess): boolean {
  return AGENT_ACCESS_STOPS.indexOf(upper) >= AGENT_ACCESS_STOPS.indexOf(lower);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_STOPS: ReadonlySet<string> = new Set(AGENT_ACCESS_STOPS);

// null: not a valid pack. A pack is token limits with areas (an absent areas
// axis would be every area) and without replies only.
export function parseAgentPack(value: unknown): ApiTokenLimits | null {
  const limits = parseApiTokenLimits(value);
  if (!limits || !limits.areas || limits.repliesOnly) return null;
  return limits;
}

// null: not a valid agents.setAccess body. A pack is required at office,
// folder and web and refused at every other stop.
export function parseAgentAccessGrant(value: unknown): AgentAccessGrant | null {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((key) => key !== "access" && key !== "pack"))
    return null;
  const access = value.access;
  if (typeof access !== "string" || !KNOWN_STOPS.has(access)) return null;
  const stop = access as AgentAccess;
  if (!stopHasPack(stop)) return "pack" in value ? null : { access: stop };
  const pack = parseAgentPack(value.pack);
  return pack ? { access: stop, pack } : null;
}

const FOLDER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];

// The exact Claude built-in tools at a stop below standard. null at standard
// and privileged: the engine default. Exact lists, never "everything except",
// so a tool a later SDK adds stays off. The office tools come from the office
// MCP server, not from this list.
export function claudeToolsForStop(access: AgentAccess): string[] | null {
  switch (access) {
    case "chat":
    case "office":
      return [];
    case "folder":
      return [...FOLDER_TOOLS];
    case "web":
      return [...FOLDER_TOOLS, ...WEB_TOOLS];
    case "standard":
    case "privileged":
      return null;
  }
}

// The engines that run every stop below standard with any model: Claude,
// and OpenCode, whose tools do not depend on the model
// (server/backends/opencode/access.ts). Codex is below, with its proven
// models only; the others need their own confinement, with a live proof,
// before they get them.
const ENGINES_BELOW_STANDARD: ReadonlySet<string> = new Set([
  "claude",
  "opencode",
]);

// The Codex models proven below standard (server/backends/codex/access.ts).
// The others keep tools no thread config turns off.
export const CODEX_BELOW_STANDARD_MODELS: readonly string[] = ["gpt-5.5"];

// Whether engine `agentType` with `model` may run an agent at `access`.
// `model` is the resolved model: null (not known yet) runs no Codex stop
// below standard.
export function engineRunsAccess(
  agentType: string,
  access: AgentAccess,
  model: string | null,
): boolean {
  if (!belowStandard(access) || ENGINES_BELOW_STANDARD.has(agentType))
    return true;
  return (
    agentType === "codex" &&
    model !== null &&
    CODEX_BELOW_STANDARD_MODELS.includes(model)
  );
}

// Whether engine `agentType` runs `access` with some model: the engine
// choice of the agent dialog, where the model follows the engine.
export function engineRunsAccessOnSomeModel(
  agentType: string,
  access: AgentAccess,
): boolean {
  return engineRunsAccess(
    agentType,
    access,
    agentType === "codex" ? CODEX_BELOW_STANDARD_MODELS[0] : null,
  );
}

// The refusal codes of the stops below standard.
// A folder that breaks the folder rules of the folder and web stops: it holds
// the office state, is the member's home, or overlaps another agent's or a
// schedule's folder.
export const FOLDER_NOT_ALLOWED = "folder_not_allowed";
// An attachment the agent's stop cannot take (a file other than an image at
// chat and office, which have no file tools).
export const ATTACHMENT_NOT_ALLOWED = "attachment_not_allowed";

// The images an agent without file tools (chat, office) still gets: inline in
// its message.
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// The areas an agent's pack can grant: the ones with an office MCP tool for
// an agent token. A pack the dialog builds names only these.
export const AGENT_PACK_AREAS = ["agents", "logs", "tasks", "asks"] as const;

export type AgentPackArea = (typeof AGENT_PACK_AREAS)[number];

// The pack presets of the agent dialog, narrowest first.
export const AGENT_PACK_PRESETS: {
  asksOnly: ApiTokenLimits;
  tasksAndAsks: ApiTokenLimits;
  talkToAgents: ApiTokenLimits;
} = {
  asksOnly: { areas: { asks: "write" } },
  tasksAndAsks: { areas: { tasks: "write", asks: "write" } },
  talkToAgents: { areas: { agents: "write", tasks: "write", asks: "write" } },
};

export type AgentPackPreset = keyof typeof AGENT_PACK_PRESETS;

// The preset whose areas `pack` has exactly, else "custom". Rooms do not
// count.
export function agentPackPresetOf(
  pack: ApiTokenLimits,
): AgentPackPreset | "custom" {
  for (const key of Object.keys(AGENT_PACK_PRESETS) as AgentPackPreset[])
    if (sameAreas(pack.areas, AGENT_PACK_PRESETS[key].areas)) return key;
  return "custom";
}

function sameAreas(
  a: ApiTokenLimits["areas"],
  b: ApiTokenLimits["areas"],
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key as ApiTokenArea] === b[key as ApiTokenArea])
  );
}

function sameRooms(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}

// Whether two grants are the same in content: the stop, and at a stop with a
// pack the same areas and the same set of rooms, whatever their order.
export function sameAccessGrant(
  a: AgentAccessGrant,
  b: AgentAccessGrant,
): boolean {
  if (a.access !== b.access) return false;
  if (!stopHasPack(a.access)) return true;
  if (!a.pack || !b.pack) return a.pack === b.pack;
  return (
    sameAreas(a.pack.areas, b.pack.areas) &&
    sameRooms(a.pack.rooms, b.pack.rooms) &&
    a.pack.repliesOnly === b.pack.repliesOnly
  );
}
