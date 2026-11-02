// Where the messaging rule of permission packs applies (task 134b8f77): every
// route that writes in the agents or agentManagement area names the agent the
// write must fit, or why it is exempt.

import {
  parseAgentAccessGrant,
  type AgentAccess,
} from "../../shared/agent-access.ts";
import type {
  ApiTokenLimits,
  RouteTokenArea,
} from "../../shared/api-token-limits.ts";
import {
  fitsInside,
  packCountsForRule,
  type FitTarget,
  type PackSender,
} from "../../shared/pack-fit.ts";
import type { Identity } from "./index.ts";
import type { GuardDeps } from "./guards.ts";

export type AgentWriteFit =
  // The agent in this route param must fit the sender.
  | { kind: "param"; name: string }
  // The agent the write creates must fit the sender.
  | { kind: "result" }
  | { kind: "exempt"; reason: string };

const ID: AgentWriteFit = { kind: "param", name: "id" };

// By route opId.
export const AGENT_WRITE_FIT_TABLE: Readonly<Record<string, AgentWriteFit>> = {
  "agents.spawn": { kind: "result" },
  "agents.revive": { kind: "result" },
  "agents.kill": ID,
  "agents.abort": ID,
  "agents.update": ID,
  "agents.setInstructions": ID,
  "agents.setManager": ID,
  "agents.move": ID,
  "agents.setTopic": ID,
  "agents.regenerateTopic": ID,
  "agents.sendMessage": ID,
  "agents.respondInteraction": ID,
  "agents.editMessage": ID,
  "agents.cancelQueued": ID,
  "agents.sendNow": ID,
  "agents.newConversation": ID,
  "agents.handoff": ID,
  "agents.resume": ID,
  "agents.upload": ID,
  "chatFiles.upload": ID,
  "rooms.swapDesks": {
    kind: "exempt",
    reason:
      "swaps two desks in one room: no agent's access, chat or work changes",
  },
  "agents.cancelScheduledMessage": {
    kind: "exempt",
    reason: ":id is the sender, which cancels its own scheduled message",
  },
  "apiTokenInbox.send": {
    kind: "exempt",
    reason: "writes to an API token's inbox, not to an agent",
  },
};

// The rule's sender for an identity with a pack that counts, else null. A
// member, a cron run and an app have no pack yet.
export function packSenderOf(identity: Identity): PackSender | null {
  if (identity.scope === "agent")
    return agentPackSender(
      identity.agentAccess ?? "standard",
      identity.apiTokenLimits,
    );
  const areas = identity.apiTokenLimits?.areas;
  if (identity.scope !== "api" || !areas || !packCountsForRule(areas))
    return null;
  return {
    agent: false,
    areas,
    ...(identity.apiTokenLimits?.rooms
      ? { rooms: identity.apiTokenLimits.rooms }
      : {}),
    ceiling: "office",
  };
}

// The rule's sender for an agent at `access` with token limits `limits`.
export function agentPackSender(
  access: AgentAccess,
  limits: ApiTokenLimits | undefined,
): PackSender | null {
  const areas = limits?.areas;
  if (!areas || !packCountsForRule(areas)) return null;
  return {
    agent: true,
    areas,
    ...(limits.rooms ? { rooms: limits.rooms } : {}),
    ceiling: access,
  };
}

// Whether a write by `identity` to agent `agentId` fits the rule, without the
// reply right. Unknown agents fit: the route's own checks answer them.
export function identityFitsAgent(
  identity: Identity,
  agentId: string,
  deps: Pick<GuardDeps, "agentFitTarget">,
): boolean {
  const sender = packSenderOf(identity);
  if (!sender || agentId === identity.agentId) return true;
  if (!deps.agentFitTarget) return false;
  const target = deps.agentFitTarget(agentId);
  return !target || fitsInside(sender, target);
}

// Whether the identity's sender heard from agent `agentId` first, so it may
// reply.
function heardFrom(
  identity: Identity,
  agentId: string,
  deps: GuardDeps,
): boolean {
  if (identity.scope === "api")
    return deps.apiTokenHeardFrom(identity.apiTokenId ?? "", agentId);
  if (identity.scope === "agent" && identity.agentId)
    return deps.agentHeardFrom?.(identity.agentId, agentId) ?? false;
  return false;
}

// The agent a spawn or a revive makes, or null when the body or the killed
// agent's record does not say enough: the rule then refuses the call.
function resultTarget(
  opId: string,
  params: Readonly<Record<string, string | undefined>>,
  body: unknown,
  deps: GuardDeps,
): FitTarget | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const roomId = typeof b.roomId === "string" ? b.roomId : "";
  if (opId === "agents.revive") {
    const grant = deps.killedAgentGrant?.(params.id ?? "");
    return grant ? { ...grant, roomId } : null;
  }
  if (b.access === undefined && b.pack === undefined)
    return { access: "standard", roomId };
  const grant = parseAgentAccessGrant({
    access: b.access,
    ...(b.pack !== undefined ? { pack: b.pack } : {}),
  });
  return grant ? { ...grant, roomId } : null;
}

// The error code of a refusal by the rule.
export const AGENT_DOES_NOT_FIT = "agent_does_not_fit";

const TARGET_OUTSIDE =
  "This agent has access outside yours. You can only reply to it, after it writes to you.";
const RESULT_OUTSIDE =
  "An agent you spawn or revive must have access and a pack inside yours.";

// The executor's check for one route call: null when the identity may make it
// under the rule, else the refusal's message. A route outside the table is
// not an agents or agentManagement write.
export function agentWriteRefusal(
  identity: Identity,
  route: { opId: string; tokenArea?: RouteTokenArea },
  params: Readonly<Record<string, string | undefined>>,
  body: unknown,
  deps: GuardDeps,
): string | null {
  const fit = AGENT_WRITE_FIT_TABLE[route.opId];
  if (!fit || fit.kind === "exempt") return null;
  const sender = packSenderOf(identity);
  if (!sender) return null;
  if (fit.kind === "result") {
    const target = resultTarget(route.opId, params, body, deps);
    return target !== null && fitsInside(sender, target)
      ? null
      : RESULT_OUTSIDE;
  }
  const agentId = params[fit.name] ?? "";
  if (identityFitsAgent(identity, agentId, deps)) return null;
  const reply =
    typeof route.tokenArea === "object" && route.tokenArea.reply === true;
  return reply && heardFrom(identity, agentId, deps) ? null : TARGET_OUTSIDE;
}
