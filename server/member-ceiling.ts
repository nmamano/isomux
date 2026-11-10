// The agent ceiling of member permission packs (task 134b8f77): the agents a
// member with a pack manages sit at or below pack.agentCeiling. A pack save,
// a manager change to the member, a revive and the boot move an agent down;
// an agent that cannot run at the ceiling blocks the save, the manager change
// and the revive, and gets no session (agent-manager.ts createSession).

import {
  agentAccessOf,
  grantAt,
  stopHasFolder,
  stopIncludes,
  type AgentAccess,
  type AgentAccessGrant,
} from "../shared/agent-access.ts";
import type { MemberPack } from "../shared/pack-fit.ts";
import type { AgentInfo, UserRecord } from "../shared/types.ts";

// What the ceiling reads of an agent, live or killed.
export type CeilingAgent = Pick<
  AgentInfo,
  "id" | "name" | "cwd" | "roomId" | "agentType" | "userId"
> & {
  modelFamily?: string;
  access?: AgentAccess;
  privileged?: boolean;
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
  // The folder rules' refusal for the agent at a folder stop under its
  // manager's pack (in its room's folder only), or null.
  folderRefusal: (agent: CeilingAgent) => string | null;
  setAccess: (agentId: string, grant: AgentAccessGrant) => Promise<unknown>;
}

// The pack of `user` when it is a member with one.
function packOf(user: UserRecord | undefined): MemberPack | undefined {
  return user?.role === "member" ? user.pack : undefined;
}

export function createMemberCeiling(deps: MemberCeilingDeps) {
  // What `pack` does to `agent`: keep at or below the ceiling, unless it is
  // at a folder stop the folder rules refuse (its folder is not its room's,
  // task 329974fe); else the ceiling (Office when the folder rules refuse a
  // folder stop) with its fixed grant, which the member's pack caps live.
  function clampFor(
    agent: CeilingAgent,
    pack: MemberPack | undefined,
  ): CeilingClamp {
    const access = agentAccessOf(agent);
    if (!pack) return { kind: "keep" };
    const atOrBelow = stopIncludes(pack.agentCeiling, access);
    if (
      atOrBelow &&
      (!stopHasFolder(access) || deps.folderRefusal(agent) === null)
    )
      return { kind: "keep" };
    const target = atOrBelow ? access : pack.agentCeiling;
    const stop =
      stopHasFolder(target) && deps.folderRefusal(agent) !== null
        ? "office"
        : target;
    const kind = deps.engineRuns(agent, stop) ? "move" : "cannot";
    return { kind, grant: grantAt(stop) };
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

  // Move each live agent of member `userId` above the ceiling down to it, and
  // one at a folder stop outside its room's folder to Office.
  // Any other agent at or below the ceiling is not touched, even when its
  // fixed grant is wider than the member's areas: its token is capped live by
  // the member's pack (server/identity/member-pack.ts), and another sender
  // that checks the fixed grant as the target sees a wider one, which only
  // refuses more.
  async function moveMemberAgentsDown(userId: string): Promise<void> {
    if (!packOf(deps.getUserById(userId))) return;
    await moveAgentsDown((agent) => agent.userId === userId);
  }

  // Move each live agent among `which` that its manager's ceiling or folder
  // rules no longer allow down (also after a move to another room or a room
  // folder change). Each is judged before any move lands; the folder rules
  // already count the manager's other agents at their stops after the clamp
  // (office-access-policy.ts ruleStopOf).
  async function moveAgentsDown(
    which: (agent: AgentInfo) => boolean,
  ): Promise<void> {
    const clamps = deps
      .getAllAgents()
      .filter(which)
      .map((agent) => ({ agent, clamp: clampedGrant(agent) }));
    await Promise.all(
      clamps.map(async ({ agent, clamp }) => {
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
    moveAgentsDown,
  };
}
