// Coming back from a dunning suspension, and from nothing else.
//
// Slice 3 suspended on dunning exhaustion and deliberately stopped there: half a
// ladder is better than an invented one. This is the other half, and the reason
// it is worth building rather than leaving to an operator is that the failure it
// prevents is a PAYING customer's office staying switched off - which is a worse
// outcome than any automation risk it carries.
//
// FOUR PREDICATES, all required, all evaluated inside the transaction that
// writes. The fourth is the one that matters most: a box inside its
// cancellation-retention month is also `suspended` and also has a succeeded
// power_off, and resuming it would restart a server the customer cancelled and
// hand back an office that is on its way to deletion.

import { deadlinesFor } from "./operations.ts";
import {
  isLifecycleRow,
  isPaymentLifecycleRow,
  latestDunningSuspension,
  resumeOperationId,
} from "./lifecycle.ts";
import { openerStamp } from "./stripe/suspension.ts";
import type { Store } from "./store.ts";
import type { SubscriptionRow } from "./stripe/billing-store.ts";
import type { Handler, HandlerContext, HandlerResult } from "./tick.ts";

export const RESUME_ACTOR = "billing-resume";

/** Stripe statuses that mean the customer is paid up. The same set dunning.ts
 * uses to close an episode: one definition of "recovered", not two. */
const HEALTHY = new Set(["active", "trialing"]);

// The resume operation's id lives in lifecycle.ts, which needs it too.
export { resumeOperationId };

export type ResumeRefusal =
  | "not_suspended"
  | "not_healthy"
  | "no_episode"
  | "cancellation_in_progress"
  | "deletion_started"
  | "no_dunning_suspension"
  | "already_open";

export type ResumeOutcome =
  { ok: true; operationId: string } | { ok: false; code: ResumeRefusal };

/**
 * Open the resume for a recovered subscription, at most once per episode.
 *
 * Must run inside the caller's transaction, so the predicates and the enqueue
 * cannot be separated by another writer.
 */
export async function requestResume(
  store: Store,
  sub: SubscriptionRow,
  now: number,
  actor: string = RESUME_ACTOR,
): Promise<ResumeOutcome> {
  if (!store.inTransaction()) {
    throw new Error("requestResume must run inside a transaction");
  }
  if (!sub.instance_id) return { ok: false, code: "no_episode" };
  const instance = await store.getInstance(sub.instance_id);
  if (!instance) return { ok: false, code: "not_suspended" };
  const operations = await store.operationsFor(sub.instance_id);

  // A payment deletion that has started is not undone by a late payment: the
  // provider may already be deleting the server. The caller raises the refund.
  // Checked BEFORE the suspended state: the usual late payment arrives after
  // the data end, when the office is deprovisioned and no longer suspended.
  if (
    HEALTHY.has(sub.status) &&
    operations.some(
      (op) =>
        isPaymentLifecycleRow(op) &&
        (op.kind === "cancel_asset" || op.kind === "remove_dns"),
    )
  ) {
    return { ok: false, code: "deletion_started" };
  }
  if (instance.service_state !== "suspended") {
    return { ok: false, code: "not_suspended" };
  }
  if (!HEALTHY.has(sub.status)) return { ok: false, code: "not_healthy" };

  // PREDICATE 4, and the one a careless implementation gets wrong: a
  // cancellation-retention box is suspended and recovered-looking too. Any
  // lifecycle row at all - power_off, cancel_asset, remove_dns, in any status -
  // means this office is on its way out and is never resumed.
  if (operations.some(isLifecycleRow)) {
    return { ok: false, code: "cancellation_in_progress" };
  }
  if (sub.ended_at !== null) {
    // Belt and braces on the same fact from the other side: a terminal
    // subscription cannot be the healthy one this function is about.
    return { ok: false, code: "cancellation_in_progress" };
  }

  const episodeId =
    latestDunningSuspension(operations)?.episode ??
    // A dunning suspension with no episode stamp is not something to guess at:
    // the whole point of the derived id is that a resume can be opened exactly
    // once, and an invented episode id would defeat it. Fall back to the
    // subscription's own episode only when it is still set.
    sub.episode_id;
  if (!episodeId) return { ok: false, code: "no_dunning_suspension" };

  const opId = resumeOperationId(episodeId);
  if (await store.getOperation(opId))
    return { ok: false, code: "already_open" };

  const d = deadlinesFor("power_on");
  await store.enqueue({
    id: opId,
    instance_id: sub.instance_id,
    kind: "power_on",
    inactivity_deadline_at: now + d.inactivityMs,
    absolute_deadline_at: now + d.absoluteMs,
    evidence: { reason: "dunning", subscription: sub.id, episode: episodeId },
  });
  await store.appendAudit({
    actor,
    instance_id: sub.instance_id,
    action: "resume_requested",
    target: opId,
    outcome: "started",
    detail: `dunning episode ${episodeId} recovered`,
  });
  return { ok: true, operationId: opId };
}

export interface ResumeDeps {
  /** Resolves when the provider reports the box on. Throws otherwise; the
   * ticker classifies the throw. */
  powerOn: (providerId: string) => Promise<void>;
  report?: (line: string) => void;
}

export function powerOnHandler(deps: ResumeDeps): Handler {
  return {
    kind: "power_on",
    // A power action is a MUTATION: a killed call proves nothing about whether
    // the provider applied it, so a timeout is ambiguous rather than retryable.
    timeoutIsRetryable: false,
    async run(ctx: HandlerContext): Promise<HandlerResult> {
      const providerId = ctx.asset?.provider_id;
      if (!providerId) {
        return {
          kind: "fatal",
          reason:
            "cannot resume an instance with no provider asset; there is " +
            "nothing to power on",
        };
      }
      ctx.budget.claim("power_on");
      await ctx.audit("power_on", "started", `provider ${providerId}`);
      try {
        await deps.powerOn(providerId);
      } catch (err) {
        await ctx.audit("power_on", "ambiguous", messageOf(err));
        throw err;
      }
      await ctx.audit("power_on", "succeeded", `provider ${providerId}`);
      deps.report?.(`resumed: provider ${providerId} powered on`);
      // It concludes when the PROVIDER has accepted the power-on, not when the
      // office answers again - the same boundary reboot draws, and for the same
      // reason: a slow boot is not a failed resume. Liveness reports the rest.
      return {
        kind: "done",
        evidence: {
          ...openerStamp(ctx.op.evidence),
          poweredOn: true,
          providerId,
          poweredOnAt: ctx.now,
        },
      };
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
