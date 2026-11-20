// accountUsage.{list,read} (tasks 3e70b6d4, faf036ad): the account usage
// card. The guard admits a member's browser session only: the rows carry
// account emails. The service cuts the rows to what the caller sees.

import { fail, ok, type RouteHandler } from "../executor.ts";
import { isOfficeOwnerIdentity } from "../../identity/guards.ts";
import type { Identity } from "../../identity/index.ts";
import type {
  AccountUsageService,
  AccountUsageViewer,
} from "../../account-usage.ts";

function viewerOf(identity: Identity): AccountUsageViewer | null {
  if (identity.scope !== "user" || !identity.userId) return null;
  return { userId: identity.userId, owner: isOfficeOwnerIdentity(identity) };
}

export function accountUsageHandlers(deps: {
  service: () => AccountUsageService;
}): Record<string, RouteHandler> {
  return {
    "accountUsage.list": (ctx) => {
      const viewer = viewerOf(ctx.identity);
      if (!viewer) return fail(403, "forbidden");
      return ok(
        deps
          .service()
          .list({ refresh: ctx.query.get("refresh") === "1", viewer }),
      );
    },
    "accountUsage.read": async (ctx) => {
      const viewer = viewerOf(ctx.identity);
      if (!viewer) return fail(403, "forbidden");
      const row = await deps.service().row(ctx.params.rowId ?? "", viewer);
      return row ? ok(row) : fail(404, "not_found");
    },
  };
}
