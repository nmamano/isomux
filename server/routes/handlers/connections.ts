import { fail, ok, type RouteHandler } from "../executor.ts";
import type {
  AgentConnectionWire,
  ConnectionsListRes,
} from "../../../shared/contract-shapes.ts";
import { isOfficeOwnerIdentity } from "../../identity/guards.ts";

export interface ConnectionsDeps {
  // officeOwner decides whether office variable names are included, by the
  // same rule as officeEnv.get.
  list(userId: string, officeOwner: boolean): Promise<ConnectionsListRes>;
  // The connections an agent of this member gets (null: no member, office
  // rows only). Never throws: an unreadable source drops its rows.
  forAgent(userId: string | null): AgentConnectionWire[];
}

export function connectionsHandlers(
  deps: ConnectionsDeps,
): Record<string, RouteHandler> {
  return {
    "connections.list": async (ctx) => {
      const { identity } = ctx;
      if (identity.scope !== "user" || !identity.userId)
        return fail(403, "forbidden");
      return ok(
        await deps.list(identity.userId, isOfficeOwnerIdentity(identity)),
      );
    },
    // The route admits agent tokens only; the scope is the token's member.
    "agentConnections.list": (ctx) => {
      const { identity } = ctx;
      if (identity.scope !== "agent") return fail(403, "forbidden");
      return ok({ connections: deps.forAgent(identity.userId) });
    },
  };
}
