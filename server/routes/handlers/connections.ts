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
  userIdForUsername(username: string): string | null;
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
    // The route admits an owner's browser session only. The member's list,
    // built as the member reads it (so office variable names follow the
    // member's rule, not the owner's).
    "memberConnections.list": async (ctx) => {
      const memberId = ctx.params.username
        ? deps.userIdForUsername(ctx.params.username)
        : null;
      if (!memberId) return fail(404, "not_found");
      return ok(await deps.list(memberId, false));
    },
    // The route admits agent tokens only; the scope is the token's member.
    "agentConnections.list": (ctx) => {
      const { identity } = ctx;
      if (identity.scope !== "agent") return fail(403, "forbidden");
      return ok({ connections: deps.forAgent(identity.userId) });
    },
  };
}
