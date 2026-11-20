// accountUsage.{list,read} (task 3e70b6d4): the owners' account usage card.
// The guard admits an owner's browser session only, as for the members'
// sign-ins: the rows carry account emails.

import { fail, ok, type RouteHandler } from "../executor.ts";
import type { AccountUsageService } from "../../account-usage.ts";

export function accountUsageHandlers(deps: {
  service: () => AccountUsageService;
}): Record<string, RouteHandler> {
  return {
    "accountUsage.list": (ctx) =>
      ok(deps.service().list({ refresh: ctx.query.get("refresh") === "1" })),
    "accountUsage.read": async (ctx) => {
      const row = await deps.service().row(ctx.params.rowId ?? "");
      return row ? ok(row) : fail(404, "not_found");
    },
  };
}
