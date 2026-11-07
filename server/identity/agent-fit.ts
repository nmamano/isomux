// Where the messaging rule of permission packs applies (task 134b8f77): every
// route that writes in the agents or agentManagement area names the agent the
// write must fit, or why it is exempt.

import {
  parseAgentAccessGrant,
  stopIncludes,
  type AgentAccess,
} from "../../shared/agent-access.ts";
import {
  intersectAreas,
  type ApiTokenLimits,
  type RouteTokenArea,
} from "../../shared/api-token-limits.ts";
import {
  fitsInside,
  managerRoomsOf,
  packCountsForRule,
  type FitTarget,
  type MemberPack,
  type PackSender,
} from "../../shared/pack-fit.ts";
import type { UserRecord } from "../../shared/types.ts";
import type { Identity } from "./index.ts";
import type { GuardDeps } from "./guards.ts";

// A refusal of the executor's agent checks.
export interface AgentWriteRefusal {
  status: 403 | 409;
  code: string;
  message: string;
}

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
  // :id is the sender; an agent cancels only its own (scheduledMessagesOwner).
  "agents.cancelScheduledMessage": ID,
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
      identity.memberPack,
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
  const rooms = bothRooms(
    identity.apiTokenLimits?.rooms,
    identity.memberPack?.rooms,
  );
  return {
    agent: false,
    areas,
    ...(rooms ? { rooms } : {}),
    ceiling,
  };
}

// The rooms inside both limits; undefined (every room) when neither has any.
function bothRooms(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] | undefined {
  if (a && b) return a.filter((room) => b.includes(room));
  const one = a ?? b;
  return one ? [...one] : undefined;
}

// The rule's sender for an agent at `access` with token limits `limits`, and
// the live pack and rooms of its manager when that member has a pack: the
// agent sends as both (areas and rooms of both, the lower stop as ceiling),
// also at Standard and on a scheduled message's fire.
export function agentPackSender(
  access: AgentAccess,
  limits: ApiTokenLimits | undefined,
  member?: { pack: MemberPack; rooms?: readonly string[] },
): PackSender | null {
  const areas = member
    ? limits?.areas
      ? intersectAreas(limits.areas, member.pack.areas)
      : member.pack.areas
    : limits?.areas;
  if (!areas || !packCountsForRule(areas)) return null;
  const rooms = bothRooms(limits?.rooms, member?.rooms);
  const ceiling =
    member && !stopIncludes(member.pack.agentCeiling, access)
      ? member.pack.agentCeiling
      : access;
  return {
    agent: true,
    areas,
    ...(rooms ? { rooms } : {}),
    ceiling,
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
  identityUserId: string | null,
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
    return grant ? { ...current, ...grant, roomId: current.roomId } : null;
  }
  const roomId = typeof b.roomId === "string" ? b.roomId : "";
  if (opId === "agents.revive") {
    const id = params.id ?? "";
    const grant = deps.killedAgentGrant?.(id);
    const manager = deps.killedAgentManagerUserId(id);
    return grant ? withManagerRooms({ ...grant, roomId }, manager, deps) : null;
  }
  // A spawn's agent is managed by the spawner's member.
  if (b.access === undefined && b.pack === undefined)
    return withManagerRooms(
      { access: "standard", roomId },
      identityUserId,
      deps,
    );
  const grant = parseAgentAccessGrant({
    access: b.access,
    ...(b.pack !== undefined ? { pack: b.pack } : {}),
  });
  return grant
    ? withManagerRooms({ ...grant, roomId }, identityUserId, deps)
    : null;
}

// `target` with the rooms its manager `userId` reaches.
function withManagerRooms(
  target: FitTarget,
  userId: string | null,
  deps: GuardDeps,
): FitTarget {
  const managerRooms = managerRoomsOf(userId ? deps.userById?.(userId) : null);
  return managerRooms ? { ...target, managerRooms } : target;
}

// The error code of a refusal by the rule.
export const AGENT_DOES_NOT_FIT = "agent_does_not_fit";
// An agent above its manager's agent ceiling: 403 to the member and their
// identities, 409 to an owner.
export const ABOVE_AGENT_CEILING = "above_agent_ceiling";
export const ABOVE_MEMBER_CEILING = "above_member_ceiling";
// A pack save, a manager change or a revive that would leave an agent above
// the ceiling with an engine that cannot run below it.
export const AGENTS_CANNOT_MOVE_DOWN = "agents_cannot_move_down";

// Whether an agent at `stop` managed by `manager` sits above that member's
// agent ceiling. Keyed on the agent's manager, whoever asks.
export function agentStopRefusal(
  manager: Pick<UserRecord, "role" | "pack"> | null | undefined,
  stop: AgentAccess,
): boolean {
  const ceiling =
    manager?.role === "member" ? manager.pack?.agentCeiling : null;
  return !!ceiling && !stopIncludes(ceiling, stop);
}

// The English name of a stop, as the access slider shows it.
export function stopName(stop: AgentAccess): string {
  return STOP_NAME[stop];
}

const STOP_NAME: Readonly<Record<AgentAccess, string>> = {
  chat: "Chat",
  office: "Office",
  folder: "Folder",
  web: "Web",
  standard: "Standard",
  privileged: "Privileged",
};

// The refusal of a spawn, setAccess or setPrivileged whose agent would sit
// above its manager's ceiling: 403 to that member and their identities, 409
// to an owner. A revive is clamped instead (server/member-ceiling.ts).
function ceilingRefusal(
  identity: Identity,
  opId: string,
  params: Readonly<Record<string, string | undefined>>,
  body: unknown,
  deps: GuardDeps,
): AgentWriteRefusal | null {
  if (opId === "agents.revive") return null;
  const target = resultTarget(
    opId,
    params,
    body,
    deps,
    identity.userId ?? null,
  );
  if (!target) return null;
  const manager =
    opId === "agents.spawn"
      ? identity.userId
        ? deps.userById?.(identity.userId)
        : null
      : deps.agentManagerOf?.(params.id ?? "");
  if (!manager?.pack || !agentStopRefusal(manager, target.access)) return null;
  const ceiling = STOP_NAME[manager.pack.agentCeiling];
  return manager.id === identity.userId
    ? {
        status: 403,
        code: ABOVE_AGENT_CEILING,
        message: `Your permission pack keeps your agents at ${ceiling} or lower.`,
      }
    : {
        status: 409,
        code: ABOVE_MEMBER_CEILING,
        message: `${manager.name}'s permission pack keeps their agents at ${ceiling} or lower.`,
      };
}

const TARGET_OUTSIDE =
  "This agent has access outside yours. You can only reply to it, after it writes to you.";
const FILES_OUTSIDE =
  "This agent has access outside yours, so you cannot open its files.";
const RESULT_OUTSIDE =
  "An agent you spawn, revive or move must have access and a pack inside yours.";

// The executor's check for one route call: null when the identity may make it,
// else the refusal: the agent ceiling first, then the messaging rule. A route
// outside both tables is not an agents or agentManagement write and does not
// open an agent's files.
export function agentWriteRefusal(
  identity: Identity,
  route: { opId: string; tokenArea?: RouteTokenArea },
  params: Readonly<Record<string, string | undefined>>,
  body: unknown,
  deps: GuardDeps,
): AgentWriteRefusal | null {
  const file = FILE_FIT[route.opId];
  if (file)
    return identityFitsAgent(identity, params[file.name] ?? "", deps)
      ? null
      : notFit(FILES_OUTSIDE);
  const fit = AGENT_WRITE_FIT_TABLE[route.opId];
  if (!fit || fit.kind === "exempt") return null;
  // A move down to Standard: the agent loses access, so it always may.
  const lowering =
    route.opId === "agents.setPrivileged" &&
    (body as { privileged?: unknown } | null)?.privileged === false;
  if (lowering) return null;
  if (fit.kind === "result") {
    const ceiling = ceilingRefusal(identity, route.opId, params, body, deps);
    if (ceiling) return ceiling;
  }
  const sender = packSenderOf(identity);
  if (!sender) return null;
  if (fit.kind === "result") {
    const target = resultTarget(
      route.opId,
      params,
      body,
      deps,
      identity.userId ?? null,
    );
    return target !== null && fitsInside(sender, target)
      ? null
      : notFit(RESULT_OUTSIDE);
  }
  const agentId = params[fit.name] ?? "";
  if (identityFitsAgent(identity, agentId, deps)) return null;
  const reply =
    typeof route.tokenArea === "object" && route.tokenArea.reply === true;
  return reply && heardFrom(identity, agentId, deps)
    ? null
    : notFit(TARGET_OUTSIDE);
}

function notFit(message: string): AgentWriteRefusal {
  return { status: 403, code: AGENT_DOES_NOT_FIT, message };
}
