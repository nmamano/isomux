// The rules of OpenCode's stop agents below standard (task e77304b1), and
// the tools a session's rule list allows. No server imports: the safety
// plugin bundle (safety-plugin.ts) reads the same functions.

import {
  belowStandard,
  stopHasFolder,
  stopHasPack,
  type AgentAccess,
} from "../../../shared/agent-access.ts";

// One OpenCode 2.1.4 permission rule.
export type OpenCodeRule = {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
};

// The Isomux agent of each stop below standard.
export const OPENCODE_STOP_AGENTS = {
  chat: "isomux-chat",
  office: "isomux-office",
  folder: "isomux-folder",
  web: "isomux-web",
} as const;

type StopBelow = keyof typeof OPENCODE_STOP_AGENTS;

// The office MCP server's name in OpenCode. Its tools are "isomux_<tool>".
export const OPENCODE_OFFICE_MCP_SERVER = "isomux";

// The built-in tools each stop adds, as 2.1.4 permission names. edit covers
// write and patch. external_directory is denied at every stop: a path
// outside the folder is refused, not asked about.
const FOLDER_PERMISSIONS = ["read", "glob", "grep", "edit"];
const WEB_PERMISSIONS = ["webfetch", "websearch"];

// The tools one permission name covers (2.1.4: write and patch check edit).
const PERMISSION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  edit: ["edit", "write", "patch"],
};

const rule = (
  action: string,
  effect: OpenCodeRule["effect"],
): OpenCodeRule => ({
  action,
  resource: "*",
  effect,
});

function stopBelow(access: AgentAccess): StopBelow | null {
  return belowStandard(access) ? (access as StopBelow) : null;
}

// The Isomux agent for `access`, or null at standard and privileged.
export function openCodeStopAgent(access: AgentAccess): string | null {
  const stop = stopBelow(access);
  return stop ? OPENCODE_STOP_AGENTS[stop] : null;
}

// The stop a session agent stands for, or null for any other agent.
export function openCodeAgentStop(agent: string): AgentAccess | null {
  for (const [stop, name] of Object.entries(OPENCODE_STOP_AGENTS))
    if (name === agent) return stop as AgentAccess;
  return null;
}

function builtInPermissions(access: AgentAccess): string[] {
  return [
    ...(stopHasFolder(access) ? FOLDER_PERMISSIONS : []),
    ...(access === "web" ? WEB_PERMISSIONS : []),
  ];
}

// The full rule list of a session below standard: deny every tool, then
// allow the stop's tools by exact name. officeTools: the office MCP server's
// tool names for this agent ("send_message"), allowed as "isomux_<name>" at
// office and above. Throws at standard and privileged.
export function openCodeStopRules(
  access: AgentAccess,
  officeTools: readonly string[],
): OpenCodeRule[] {
  if (!stopBelow(access))
    throw new Error(
      `OpenCode stop rules are for a stop below standard, not ${access}.`,
    );
  const office = stopHasPack(access)
    ? officeTools.map((tool) => `${OPENCODE_OFFICE_MCP_SERVER}_${tool}`)
    : [];
  return [
    rule("*", "deny"),
    ...[...office, ...builtInPermissions(access)].map((name) =>
      rule(name, "allow"),
    ),
    rule("external_directory", "deny"),
  ];
}

// The rules of a stop's agent block in Isomux's config: the stop's built-in
// tools, no office tool (the session adds the exact names).
export function openCodeStopAgentRules(access: AgentAccess): OpenCodeRule[] {
  return [
    rule("*", "deny"),
    ...builtInPermissions(access).map((name) => rule(name, "allow")),
    rule("external_directory", "deny"),
  ];
}

// 2.1.4 matches an action as a pattern: "*" stands for any run of
// characters.
function actionMatches(action: string, permission: string): boolean {
  if (!action.includes("*")) return action === permission;
  const pattern = action
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(permission);
}

// The tool names a session's rule list allows by exact name: each allow
// rule whose action has no wildcard and that no later rule overrides, with
// OpenCode's permission names mapped to the tools they cover (edit: edit,
// write and patch). A wildcard allow adds nothing; an unreadable list
// allows nothing.
export function openCodeAllowedTools(rules: unknown): string[] {
  if (!Array.isArray(rules)) return [];
  const list: { action: string; effect: unknown }[] = [];
  for (const entry of rules as unknown[]) {
    const action = (entry as { action?: unknown } | null)?.action;
    if (typeof action !== "string") return [];
    list.push({ action, effect: (entry as { effect?: unknown }).effect });
  }
  const allowed = new Set<string>();
  list.forEach(({ action, effect }, index) => {
    if (effect !== "allow" || /[*?[\]{}]/.test(action)) return;
    const later = list.slice(index + 1);
    if (later.some((next) => actionMatches(next.action, action))) return;
    for (const tool of PERMISSION_TOOLS[action] ?? [action]) allowed.add(tool);
  });
  return [...allowed];
}
