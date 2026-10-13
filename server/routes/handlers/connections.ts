import { fail, ok, type RouteHandler } from "../executor.ts";
import type { ConnectionsListRes } from "../../../shared/contract-shapes.ts";
import { isOfficeOwnerIdentity } from "../../identity/guards.ts";

export interface ConnectionsDeps {
  // officeOwner decides whether office variable names are included, by the
  // same rule as officeEnv.get.
  list(userId: string, officeOwner: boolean): Promise<ConnectionsListRes>;
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
  };
}
