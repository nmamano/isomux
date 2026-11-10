// What an agent may use: one stop on the access slider. Each stop has
// everything the stop below it has. Below Standard the agent has no shell and
// reaches the office only through the office MCP server, with its token
// limited to the fixed office grant.

import type { ApiTokenAreaLevels, ApiTokenLimits } from "./api-token-limits.ts";

export const AGENT_ACCESS_STOPS = [
  // No tools and no office MCP server: the agent only answers in its chat.
  "chat",
  // The office MCP server with the fixed office grant, no engine file tools.
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

// The limits of the token of an agent at office, folder and web: agents,
// tasks and asks write, no logs, every room its manager can access. Read it
// through grantAt, which gives a fresh copy.
const AGENT_OFFICE_AREAS: Readonly<ApiTokenAreaLevels> = {
  agents: "write",
  tasks: "write",
  asks: "write",
};

// A stop and its token limits. `pack` is present exactly at office, folder
// and web, and is always the fixed office grant.
export interface AgentAccessGrant {
  access: AgentAccess;
  pack?: ApiTokenLimits;
}

// The grant at `access`: a fresh object each call, as consumers spread and
// intersect it.
export function grantAt(access: AgentAccess): AgentAccessGrant {
  return stopHasPack(access)
    ? { access, pack: { areas: { ...AGENT_OFFICE_AREAS } } }
    : { access };
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

// The grant of an agent record, as its token is minted with it. A pack an
// older version saved on the record is not read: the stop decides.
export function accessGrantOf(info: {
  access?: AgentAccess;
  privileged?: boolean;
}): AgentAccessGrant {
  return grantAt(agentAccessOf(info));
}

// Whether `access` has no shell (a stop below standard).
export function belowStandard(access: AgentAccess): boolean {
  return (
    AGENT_ACCESS_STOPS.indexOf(access) < AGENT_ACCESS_STOPS.indexOf("standard")
  );
}

// Whether `access` has the office MCP server with the fixed office grant.
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

// The refusal of a request that still sends an agent pack (`field` names it,
// for example "pack" or "step.pack").
export function packNotAccepted(field: string): string {
  return `${field} is no longer accepted. The access stop alone sets the agent's office tools.`;
}

// null: not a valid agents.setAccess body. The body is {access} alone: a
// pack is no longer accepted at any stop, so a caller that asks for a narrow
// one is told instead of getting the wider fixed grant.
export function parseAgentAccessGrant(value: unknown): AgentAccessGrant | null {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((key) => key !== "access")) return null;
  const access = value.access;
  if (typeof access !== "string" || !KNOWN_STOPS.has(access)) return null;
  return grantAt(access as AgentAccess);
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

// Whether two grants are the same: the stop decides the limits.
export function sameAccessGrant(
  a: AgentAccessGrant,
  b: AgentAccessGrant,
): boolean {
  return a.access === b.access;
}
