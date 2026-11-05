// GET /api/me/opencode (opId openCode.status): the OpenCode free-limit state
// and the source of the caller's OPENCODE_API_KEY, for the Model providers tab.
//
// LEAF over the executor + shared types. Only the injected OpenCodeDeps.

import { fail, ok, type RouteHandler } from "../executor.ts";
import type { OpenCodeStatusRes } from "../../../shared/contract-shapes.ts";

export interface OpenCodeDeps {
  status(userId: string): OpenCodeStatusRes;
}

export function openCodeHandlers(
  deps: OpenCodeDeps,
): Record<string, RouteHandler> {
  return {
    "openCode.status": async (ctx) => {
      const userId = ctx.identity.scope === "user" ? ctx.identity.userId : null;
      if (!userId) return fail(403, "forbidden");
      return ok(deps.status(userId));
    },
  };
}
