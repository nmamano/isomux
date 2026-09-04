// Storage resource handlers - disk-usage visibility and manual pruning of the
// office's on-disk history.
//
// GET /api/storage/usage - office:read + authenticated: every human, plus
// privileged agents (the same posture as /api/backup/status; a plain agent
// token lacks office:read and gets 403). Per-AGENT detail is OWNER-only: the
// breakdown enumerates every agent log directory on disk, including agents in
// rooms the caller cannot see and agents killed long ago, so a member or a
// privileged agent gets the category aggregates only.
//
// POST /api/storage/prune - office:admin + officeOwner, and DRY RUN BY DEFAULT.
// The response always carries the full plan; files are removed only when the
// body says `"apply": true`. Nothing in the server ever calls this on a timer -
// there is no retention scheduler (see server/storage-prune.ts).
//
// LEAF over the executor. Only the injected StorageDeps.

import { ok, fail, type RouteHandler } from "../executor.ts";
import { aggregateOnly, type StorageUsage } from "../../storage-usage.ts";
import {
  QUEUE_STATE_UNKNOWN,
  type PrunePlan,
  type PrunePolicy,
  type PruneResult,
  type PruneTarget,
} from "../../storage-prune.ts";

export interface StorageDeps {
  // Full breakdown including per-agent detail; the handler strips the detail
  // for non-owners.
  getUsage(): StorageUsage;
  planPrune(target: PruneTarget, policy: PrunePolicy): PrunePlan;
  applyPrune(plan: PrunePlan): PruneResult;
}

const TARGETS: readonly PruneTarget[] = ["transcripts", "attachments"];

// A prune that could reach today's files is not a retention policy, it is a
// wipe. The floor is a guard rail, not a recommendation.
const MIN_OLDER_THAN_DAYS = 1;

function isPositiveInt(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

export function storageHandlers(
  deps: StorageDeps,
): Record<string, RouteHandler> {
  return {
    "storage.usage": (ctx) => {
      const usage = deps.getUsage();
      const isOwner =
        ctx.identity.scope === "user" && ctx.identity.role === "owner";
      return ok(isOwner ? usage : aggregateOnly(usage));
    },

    "storage.prune": (ctx) => {
      const b = (ctx.body ?? {}) as {
        target?: unknown;
        olderThanDays?: unknown;
        keepPerAgent?: unknown;
        apply?: unknown;
      };
      const target = b.target;
      if (
        typeof target !== "string" ||
        !TARGETS.includes(target as PruneTarget)
      ) {
        return fail(
          400,
          "invalid_target",
          `target must be one of: ${TARGETS.join(", ")}`,
        );
      }
      if (!isPositiveInt(b.olderThanDays, MIN_OLDER_THAN_DAYS)) {
        return fail(
          400,
          "invalid_older_than_days",
          `olderThanDays must be an integer of at least ${MIN_OLDER_THAN_DAYS}`,
        );
      }
      // Absent keepPerAgent means "keep nothing on recency alone"; it is only
      // meaningful for transcripts, and an explicit value must still be sane.
      if (b.keepPerAgent !== undefined && !isPositiveInt(b.keepPerAgent, 0)) {
        return fail(
          400,
          "invalid_keep_per_agent",
          "keepPerAgent must be a non-negative integer",
        );
      }
      if (b.apply !== undefined && typeof b.apply !== "boolean") {
        return fail(400, "invalid_apply", "apply must be a boolean");
      }
      // keepPerAgent defaults to 0, which is the sharpest setting there is:
      // "spare nothing on recency". Fine to explore with on a dry run, not fine
      // to inherit silently on a delete - a real transcript apply must say it.
      if (
        b.apply === true &&
        target === "transcripts" &&
        b.keepPerAgent === undefined
      ) {
        return fail(
          400,
          "keep_per_agent_required",
          "keepPerAgent must be stated explicitly when applying a transcript prune (0 keeps nothing on recency alone)",
        );
      }

      const policy: PrunePolicy = {
        olderThanDays: b.olderThanDays,
        keepPerAgent: b.keepPerAgent ?? 0,
      };
      const plan = deps.planPrune(target as PruneTarget, policy);
      // Fail closed, loudly. When the durable message queue could not be read,
      // the planner has already spared everything - so an apply would be a
      // harmless no-op, and that is exactly the problem: it would report
      // "deleted 0" as if there were nothing to prune. Say why instead.
      if (
        b.apply === true &&
        plan.skipped.some((s) => s.reason === QUEUE_STATE_UNKNOWN)
      ) {
        return fail(
          409,
          "queue_state_unreadable",
          "the durable message queue could not be read, so it is unknown which attachments are still owed to undelivered messages; refusing to delete until it is readable",
        );
      }
      // Dry run unless the caller explicitly opted in. `applied: null` is the
      // signal that nothing was touched - never an empty result object, which
      // would read like a prune that found nothing to do.
      const applied = b.apply === true ? deps.applyPrune(plan) : null;
      return ok({ plan, applied });
    },
  };
}
