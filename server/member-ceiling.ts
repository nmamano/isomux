// The agent ceiling of member permission packs (task 134b8f77): the agents a
// member with a pack manages sit at or below pack.agentCeiling. A pack save,
// a manager change to the member, a revive and the boot move an agent down;
// an agent that cannot run at the ceiling blocks the save, the manager change
// and the revive, and gets no session (agent-manager.ts createSession).

import {
  agentAccessOf,
  stopHasFolder,
  stopHasPack,
  stopIncludes,
  type AgentAccess,
  type AgentAccessGrant,
} from "../shared/agent-access.ts";
import {
  intersectAreas,
  type ApiTokenLimits,
} from "../shared/api-token-limits.ts";
import type { MemberPack } from "../shared/pack-fit.ts";
import type { AgentInfo, UserRecord } from "../shared/types.ts";

// What the ceiling reads of an agent, live or killed.
export type CeilingAgent = Pick<
  AgentInfo,
  "id" | "name" | "cwd" | "agentType" | "userId"
> & {
  modelFamily?: string;
  access?: AgentAccess;
  privileged?: boolean;
  pack?: ApiTokenLimits;
};

// What a manager's ceiling does to an agent: nothing, a move to `grant`, or
// nothing it can do (the engine cannot run at `grant`, the move it needs).
export type CeilingClamp =
  | { kind: "keep" }
  | { kind: "move"; grant: AgentAccessGrant }
  | { kind: "cannot"; grant: AgentAccessGrant };

export interface MemberCeilingDeps {
  getUserById: (id: string) => UserRecord | undefined;
  getAllAgents: () => AgentInfo[];
  // Whether the agent's engine and model run `access` on this server.
  engineRuns: (agent: CeilingAgent, access: AgentAccess) => boolean;
  // The folder rules' refusal for the agent at a folder stop, or null.
  folderRefusal: (agent: CeilingAgent) => string | null;
  setAccess: (agentId: string, grant: AgentAccessGrant) => Promise<unknown>;
}

// The pack of `user` when it is a member with one.
function packOf(user: UserRecord | undefined): MemberPack | undefined {
  return user?.role === "member" ? user.pack : undefined;
}

export function createMemberCeiling(deps: MemberCeilingDeps) {
  // What `pack` does to `agent`: keep at or below the ceiling; else the
  // ceiling (Office when the folder rules refuse a folder stop) with a pack
  // inside the member's areas.
  function clampFor(
    agent: CeilingAgent,
    pack: MemberPack | undefined,
  ): CeilingClamp {
    const access = agentAccessOf(agent);
    if (!pack || stopIncludes(pack.agentCeiling, access))
      return { kind: "keep" };
    const stop =
      stopHasFolder(pack.agentCeiling) && deps.folderRefusal(agent) !== null
        ? "office"
        : pack.agentCeiling;
    const kind = deps.engineRuns(agent, stop) ? "move" : "cannot";
    if (!stopHasPack(stop)) return { kind, grant: { access: stop } };
    // An agent with a pack keeps its rooms and gets the member's areas inside
    // its own; a Standard or Privileged one gets the member's areas.
    const own = stopHasPack(access) ? agent.pack : undefined;
    const pack2: ApiTokenLimits = own?.areas
      ? { ...own, areas: intersectAreas(own.areas, pack.areas) }
      : { areas: pack.areas };
    return { kind, grant: { access: stop, pack: pack2 } };
  }

  // What the ceiling of `agent`'s manager does to it.
  function clampedGrant(agent: CeilingAgent): CeilingClamp {
    return clampFor(
      agent,
      packOf(agent.userId ? deps.getUserById(agent.userId) : undefined),
    );
  }

  // The live agents of member `userId` that `pack` would leave above the
  // ceiling with an engine that cannot run at it.
  function agentsThatCannotMoveDown(
    userId: string,
    pack: MemberPack,
  ): AgentInfo[] {
    return deps
      .getAllAgents()
      .filter(
        (agent) =>
          agent.userId === userId && clampFor(agent, pack).kind === "cannot",
      );
  }

  // Move each live agent of member `userId` above the ceiling down to it.
  // An agent at or below the ceiling is not touched, even when its stored pack
  // is wider than the member's areas: its token is capped live by the member's
  // pack (server/identity/member-pack.ts), and another sender that checks the
  // stored pack as the target sees a wider pack, which only refuses more.
  // Rewriting it would rotate its token and end its turn for nothing.
  async function moveMemberAgentsDown(userId: string): Promise<void> {
    const pack = packOf(deps.getUserById(userId));
    if (!pack) return;
    await Promise.all(
      deps
        .getAllAgents()
        .filter((agent) => agent.userId === userId)
        .map(async (agent) => {
          const clamp = clampFor(agent, pack);
          if (clamp.kind === "keep") return;
          if (clamp.kind === "cannot") {
            console.error(
              `[ceiling] ${agent.name} (${agent.id}) cannot run at the agent ceiling of its manager; it gets no session`,
            );
            return;
          }
          try {
            await deps.setAccess(agent.id, clamp.grant);
          } catch (err) {
            console.error(
              `[ceiling] ${agent.name} (${agent.id}) did not move down:`,
              err,
            );
          }
        }),
    );
  }

  return {
    clampFor,
    clampedGrant,
    agentsThatCannotMoveDown,
    moveMemberAgentsDown,
  };
}
