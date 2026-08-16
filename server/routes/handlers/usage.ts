import type { UsageReportWire } from "../../../shared/contract-shapes.ts";
import type { UserRecord } from "../../../shared/types.ts";
import { usageAudienceForUser } from "../../usage-report.ts";
import { ok, type RouteHandler } from "../executor.ts";

export interface UsageDeps {
  getUserById(id: string | null): UserRecord | undefined;
  getReport(audience: ReturnType<typeof usageAudienceForUser>): UsageReportWire;
}

export function usageHandlers(deps: UsageDeps): Record<string, RouteHandler> {
  return {
    "usage.read": (ctx) => {
      const user = deps.getUserById(ctx.identity.userId);
      return ok(deps.getReport(usageAudienceForUser(user)));
    },
  };
}
