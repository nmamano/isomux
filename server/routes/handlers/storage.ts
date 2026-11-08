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
// body says `"apply": true`. The daily automatic cleanup
// (server/storage-retention.ts) calls the same planners and appliers, not
// this route. An apply while the storage lock is held is a 409 storage_busy.
//
// GET /api/storage/retention - the automatic cleanup's ages and last run, with
// the usage route's gate. PUT /api/storage/retention - owner-only, like
// PUT /api/backup/settings.
//
// POST /api/storage/compress - the same gate and the same dry-run default. It
// gzips old transcripts in place (server/storage-compress.ts); nothing is lost.
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
import type { CompressPlan, CompressResult } from "../../storage-compress.ts";
import type {
  LogRetentionReq,
  LogRetentionWire,
} from "../../../shared/contract-shapes.ts";

export interface StorageDeps {
  // Full breakdown including per-agent detail; the handler strips the detail
  // for non-owners.
  getUsage(): StorageUsage;
  planPrune(target: PruneTarget, policy: PrunePolicy): PrunePlan;
  // Both appliers reject with StorageBusyError while the storage lock is
  // held (the automatic cleanup or another apply).
  applyPrune(plan: PrunePlan): PruneResult | Promise<PruneResult>;
  planCompress(olderThanDays: number): CompressPlan;
  applyCompress(plan: CompressPlan): Promise<CompressResult>;
  // The automatic log cleanup (server/storage-retention.ts).
  getRetention(): LogRetentionWire;
  // Validates, then saves. { ok: false } is a 400 with the error.
  setRetention(
    input: LogRetentionReq,
  ): { ok: true; res: LogRetentionWire } | { ok: false; error: string };
}

// Thrown by an apply while another apply or the automatic cleanup holds the
// storage lock; the handler answers 409 storage_busy.
export class StorageBusyError extends Error {
  constructor() {
    super("storage busy");
    this.name = "StorageBusyError";
  }
}

const TARGETS: readonly PruneTarget[] = [
  "transcripts",
  "attachments",
  "token-logs",
  "terminal-recordings",
];

// A prune that could reach today's files is not a retention policy, it is a
// wipe. The floor is a guard rail, not a recommendation.
export const MIN_OLDER_THAN_DAYS = 1;

function storageBusy() {
  return fail(
    409,
    "storage_busy",
    "an automatic cleanup or another cleanup is running; try again when it ends",
  );
}

function isPositiveInt(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

// The body of a prune, as the route takes it: the route and an action ask
// (server/step-asks.ts) read it here, so both refuse alike. `forApply`: the
// action ask always applies, so it needs what an apply needs.
export function parsePruneRequest(
  body: unknown,
  forApply = false,
):
  | {
      ok: true;
      req: {
        target: PruneTarget;
        olderThanDays: number;
        keepPerAgent?: number;
        apply?: boolean;
      };
    }
  | { ok: false; code: string; message: string } {
  const b = (body ?? {}) as {
    target?: unknown;
    olderThanDays?: unknown;
    keepPerAgent?: unknown;
    apply?: unknown;
  };
  const target = b.target;
  if (typeof target !== "string" || !TARGETS.includes(target as PruneTarget)) {
    return {
      ok: false,
      code: "invalid_target",
      message: `target must be one of: ${TARGETS.join(", ")}`,
    };
  }
  if (!isPositiveInt(b.olderThanDays, MIN_OLDER_THAN_DAYS)) {
    return {
      ok: false,
      code: "invalid_older_than_days",
      message: `olderThanDays must be an integer of at least ${MIN_OLDER_THAN_DAYS}`,
    };
  }
  // Absent keepPerAgent means "keep nothing on recency alone"; it is only
  // meaningful for transcripts, and an explicit value must still be sane.
  if (b.keepPerAgent !== undefined && !isPositiveInt(b.keepPerAgent, 0)) {
    return {
      ok: false,
      code: "invalid_keep_per_agent",
      message: "keepPerAgent must be a non-negative integer",
    };
  }
  if (b.apply !== undefined && typeof b.apply !== "boolean") {
    return {
      ok: false,
      code: "invalid_apply",
      message: "apply must be a boolean",
    };
  }
  // keepPerAgent defaults to 0, which is the sharpest setting there is:
  // "spare nothing on recency". Fine to explore with on a dry run, not fine
  // to inherit silently on a delete - a real transcript apply must say it.
  if (
    (forApply || b.apply === true) &&
    target === "transcripts" &&
    b.keepPerAgent === undefined
  ) {
    return {
      ok: false,
      code: "keep_per_agent_required",
      message:
        "keepPerAgent must be stated explicitly when applying a transcript prune (0 keeps nothing on recency alone)",
    };
  }
  return {
    ok: true,
    req: {
      target: target as PruneTarget,
      olderThanDays: b.olderThanDays,
      ...(b.keepPerAgent !== undefined ? { keepPerAgent: b.keepPerAgent } : {}),
      ...(b.apply !== undefined ? { apply: b.apply } : {}),
    },
  };
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

    "storage.prune": async (ctx) => {
      const parsed = parsePruneRequest(ctx.body);
      if (!parsed.ok) return fail(400, parsed.code, parsed.message);
      const { target, apply } = parsed.req;
      const policy: PrunePolicy = {
        olderThanDays: parsed.req.olderThanDays,
        keepPerAgent: parsed.req.keepPerAgent ?? 0,
      };
      const plan = deps.planPrune(target, policy);
      // Fail closed, loudly. When the durable message queue could not be read,
      // the planner has already spared everything - so an apply would be a
      // harmless no-op, and that is exactly the problem: it would report
      // "deleted 0" as if there were nothing to prune. Say why instead.
      if (
        apply === true &&
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
      try {
        const applied = apply === true ? await deps.applyPrune(plan) : null;
        return ok({ plan, applied });
      } catch (err) {
        if (err instanceof StorageBusyError) return storageBusy();
        throw err;
      }
    },

    // Lossless, so no keepPerAgent and no fork-ancestor rule; the same age
    // floor and the same dry-run default as storage.prune.
    "storage.compress": async (ctx) => {
      const b = (ctx.body ?? {}) as {
        olderThanDays?: unknown;
        apply?: unknown;
      };
      if (!isPositiveInt(b.olderThanDays, MIN_OLDER_THAN_DAYS)) {
        return fail(
          400,
          "invalid_older_than_days",
          `olderThanDays must be an integer of at least ${MIN_OLDER_THAN_DAYS}`,
        );
      }
      if (b.apply !== undefined && typeof b.apply !== "boolean") {
        return fail(400, "invalid_apply", "apply must be a boolean");
      }
      const plan = deps.planCompress(b.olderThanDays);
      try {
        const applied =
          b.apply === true ? await deps.applyCompress(plan) : null;
        return ok({ plan, applied });
      } catch (err) {
        if (err instanceof StorageBusyError) return storageBusy();
        throw err;
      }
    },

    // office:read + authenticated, like system.backupStatus.
    "storage.retention": () => ok(deps.getRetention()),

    // Owner-only (route table), like system.setBackupSettings. Every field is
    // checked before any is saved, so a 400 leaves the settings as they were.
    "storage.setRetention": (ctx) => {
      const b = ctx.body;
      if (!b || typeof b !== "object" || Array.isArray(b))
        return fail(400, "invalid_body", "the body must be a JSON object");
      const result = deps.setRetention(b);
      return result.ok
        ? ok(result.res)
        : fail(400, "invalid_retention_settings", result.error);
    },
  };
}
