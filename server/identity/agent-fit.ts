// Where the messaging rule of permission packs applies (task 134b8f77): every
// route that writes in the agents or agentManagement area names the agent the
// write must fit, or why it is exempt.

import {
  parseAgentAccessGrant,
  stopIncludes,
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
  // The agent's new stop and pack must fit; a move down from Privileged
  // always may.
  "agents.setAccess": { kind: "result" },
  "agents.setPrivileged": { kind: "result" },
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
  ...Object.fromEntries(
    [
      "browser.pair",
      "browser.reload",
      "browser.revoke",
      "browser.revokeOne",
    ].map((opId) => [
      opId,
      {
        kind: "exempt",
        reason:
          "pairs, reloads or revokes the member's own browser; each tab offer to an agent checks the fit (mayReachExtension)",
      } as const,
    ]),
  ),
  "apiTokenInbox.send": {
    kind: "exempt",
    reason: "writes to an API token's inbox, not to an agent",
  },
};

// The routes that open an agent's files in the file panel: a sender with a
// pack that counts opens them only on agents that fit it.
export const FILE_FIT: Readonly<
  Record<string, { kind: "param"; name: string }>
> = {
  "agents.openFile": { kind: "param", name: "id" },
  "agents.saveFile": { kind: "param", name: "id" },
  "agents.closeFile": { kind: "param", name: "id" },
};

// The rule's sender for an identity with a pack that counts, else null: an
// agent below Standard, a token with limits, and every identity of a member
// with a permission pack (identity.memberPack). An agent's ceiling is its own
// stop, a token's office, and a member's the pack's agentCeiling; a member's
// token gets the lower of the two.
export function packSenderOf(identity: Identity): PackSender | null {
  if (identity.scope === "agent")
    return agentPackSender(
      identity.agentAccess ?? "standard",
      identity.apiTokenLimits,
    );
  const areas = identity.apiTokenLimits?.areas;
  const member = identity.memberPack?.pack.agentCeiling;
  if (identity.scope !== "api" && !member) return null;
  if (!areas || !packCountsForRule(areas)) return null;
  const ceiling: AgentAccess =
    identity.scope !== "api"
      ? member!
      : member && stopIncludes("office", member)
        ? member
        : "office";
  // A member's rooms bound the agents they reach: an agent whose pack reaches
  // other rooms would act there for them. A member's token: the rooms of both.
  const tokenRooms = identity.apiTokenLimits?.rooms;
  const memberRooms = identity.memberPack?.rooms;
  const rooms =
    memberRooms && tokenRooms
      ? tokenRooms.filter((room) => memberRooms.includes(room))
      : (memberRooms ?? tokenRooms);
  return {
    agent: false,
    areas,
    ...(rooms ? { rooms } : {}),
    ceiling,
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
  // A member's session only: their tokens keep their own reply right.
  if (identity.scope === "user" && identity.userId)
    return deps.memberHeardFrom?.(identity.userId, agentId) ?? false;
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
  if (opId === "agents.setAccess" || opId === "agents.setPrivileged") {
    // The agent keeps its room.
    const current = deps.agentFitTarget?.(params.id ?? "");
    if (!current) return null;
    if (opId === "agents.setPrivileged")
      return { access: "privileged", roomId: current.roomId };
    const grant = parseAgentAccessGrant({
      access: b.access,
      ...(b.pack !== undefined ? { pack: b.pack } : {}),
    });
    return grant ? { ...grant, roomId: current.roomId } : null;
  }
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
const FILES_OUTSIDE =
  "This agent has access outside yours, so you cannot open its files.";
const RESULT_OUTSIDE =
  "An agent you spawn, revive or move must have access and a pack inside yours.";

// The executor's check for one route call: null when the identity may make it
// under the rule, else the refusal's message. A route outside both tables is
// not an agents or agentManagement write and does not open an agent's files.
export function agentWriteRefusal(
  identity: Identity,
  route: { opId: string; tokenArea?: RouteTokenArea },
  params: Readonly<Record<string, string | undefined>>,
  body: unknown,
  deps: GuardDeps,
): string | null {
  const file = FILE_FIT[route.opId];
  if (file)
    return identityFitsAgent(identity, params[file.name] ?? "", deps)
      ? null
      : FILES_OUTSIDE;
  const fit = AGENT_WRITE_FIT_TABLE[route.opId];
  if (!fit || fit.kind === "exempt") return null;
  const sender = packSenderOf(identity);
  if (!sender) return null;
  // A move down to Standard: the agent loses access, so it always may.
  const lowering =
    route.opId === "agents.setPrivileged" &&
    (body as { privileged?: unknown } | null)?.privileged === false;
  if (lowering) return null;
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
