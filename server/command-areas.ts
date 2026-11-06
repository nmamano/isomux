// The token areas a chat command needs (task 79d755d7). A command that does
// what an HTTP route does needs that route's area, so a member's permission
// pack or a limited API token refuses the command where it refuses the route.
// The areas are read from the route table, so a change to a route's area
// carries to its command.

import { API_ROUTES } from "./routes/table.ts";
import {
  routeAllowedByLimits,
  type ApiTokenLimits,
  type RouteTokenArea,
} from "../shared/api-token-limits.ts";
import { commands } from "../shared/commands.ts";
import type { AgentChoiceInteractionKind } from "../shared/types.ts";

// Command handler (shared/commands.ts `handler`) -> the routes that do the
// same thing. A handler not listed (help, usage, plan, login, logout,
// reloadPlugins, isomuxAllHands) has no twin, or one the send route covers.
const COMMAND_TWINS: Record<string, readonly string[]> = {
  // A member reads files through the open-file route; agents.diff is the
  // agent's own diff affordance.
  isomuxDiff: ["agents.openFile"],
  isomuxEdit: ["agents.openFile"],
  model: ["agents.update"],
  effort: ["agents.update"],
  rename: ["agents.setTopic"],
  isomuxUsage: ["usage.read"],
  isomuxStorage: ["storage.usage"],
  context: ["agents.contextUsage"],
  isomuxSystemPrompt: ["agents.readSystemPrompt"],
  isomuxCronjobSystemPrompt: ["cron.readSystemPrompt"],
  // The picker lists the sessions before one resumes.
  resume: ["agents.listSessions", "agents.resume"],
  clear: ["agents.newConversation"],
  handoff: ["agents.handoff"],
};

// An answer to a picker needs the areas of the command that opened it.
const INTERACTION_COMMANDS: Partial<
  Record<AgentChoiceInteractionKind, string>
> = {
  model: "model",
  effort: "effort",
  resume: "resume",
  cronjob: "isomuxCronjobSystemPrompt",
};

type TokenArea = Exclude<RouteTokenArea, "always">;

function twinArea(opId: string): RouteTokenArea {
  const route = API_ROUTES.find((r) => r.opId === opId);
  if (!route?.tokenArea)
    throw new Error(`${opId} is missing from API_ROUTES or has no tokenArea`);
  return route.tokenArea;
}

const COMMAND_AREAS: ReadonlyMap<string, readonly RouteTokenArea[]> = new Map(
  Object.entries(COMMAND_TWINS).map(([handler, opIds]) => [
    handler,
    opIds.map(twinArea),
  ]),
);

// The first area of `handler`'s twins that `limits` refuses, or null. No
// limits = full access.
function commandAreaRefused(
  limits: ApiTokenLimits | undefined,
  handler: string | undefined,
): TokenArea | null {
  if (!limits || !handler) return null;
  for (const area of COMMAND_AREAS.get(handler) ?? []) {
    if (!routeAllowedByLimits(limits, area))
      return area === "always" ? null : { area: area.area, level: area.level };
  }
  return null;
}

// The first area `limits` refuses for an answer to a `kind` picker, or null.
export function interactionAreaRefused(
  limits: ApiTokenLimits | undefined,
  kind: AgentChoiceInteractionKind | undefined,
): TokenArea | null {
  return commandAreaRefused(limits, kind && INTERACTION_COMMANDS[kind]);
}

// The first area `limits` refuses for the command `text` names, split as the
// slash dispatcher splits it, or null. A command a skill may shadow runs no
// Isomux handler here.
export function slashCommandAreaRefused(
  limits: ApiTokenLimits | undefined,
  text: string,
): TokenArea | null {
  if (!text.startsWith("/")) return null;
  const name = text.slice(1).trim().split(/\s+/)[0];
  const cfg = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!cfg || cfg.overridable || !cfg.supported) return null;
  return commandAreaRefused(limits, cfg.handler);
}

// The send refusal for a sender whose limits lack `area`, in the route
// refusal's shape (server/routes/executor.ts authorizeRoute).
export function areaRefusal(area: TokenArea): {
  ok: false;
  status: 403;
  code: "forbidden";
  message: string;
  detail: Record<string, unknown>;
} {
  return {
    ok: false,
    status: 403,
    code: "forbidden",
    message: "The sender's limits do not allow this command.",
    detail: { area: area.area, level: area.level },
  };
}
