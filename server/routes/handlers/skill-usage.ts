// Skill-usage handler — the caller's own per-skill use counters on the unified
// REST surface (opId skills.usageCounts). Read-only: increments happen at the
// slash-command dispatch site (command-handlers.ts), never through a route.
// The counts are keyed off the resolved identity's userId (for an agent or
// cron-run token that is the owning user), NEVER a param or body field — one
// caller cannot read another user's counts. An identity with no userId gets an
// empty map, not an error: counts are a sort hint, absence of history is a
// valid answer.
//
// LEAF over the executor + injected SkillUsageDeps. No manager/store imports.

import { ok, type RouteHandler } from "../executor.ts";

export interface SkillUsageDeps {
  countsFor(userId: string): Record<string, number>;
}

export function skillUsageHandlers(
  deps: SkillUsageDeps,
): Record<string, RouteHandler> {
  return {
    "skills.usageCounts": (ctx) => {
      const userId = ctx.identity.userId;
      return ok({ counts: userId ? deps.countsFor(userId) : {} });
    },
  };
}
