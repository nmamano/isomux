// The suspension boundary: one handler that powers a box off at the provider.
//
// This is where billing stops and provisioning starts. Ruling 3 leaves no way to
// stop a service from inside a handed-off office, so "suspend" is a provider
// power action or it does not happen.
//
// The provider call is INJECTED, and slice 3 never wires a real one: billing-cli
// deliberately leaves this handler unregistered, exactly as cli.ts leaves
// `create_instance` unregistered, so no runnable command in this slice can touch a
// real box. An enqueued suspension therefore surfaces as slice 2's
// no-handler-registered condition - a failed operation with attention raised -
// which is the honest state of the world while the boundary is only half built.

import { deadlinesFor } from "../operations.ts";
import type { Store } from "../store.ts";
import type { SubscriptionRow } from "./billing-store.ts";
import { suspensionOperationId } from "./dunning.ts";
import type { Handler, HandlerContext, HandlerResult } from "../tick.ts";

/**
 * Open the suspension operation for a dunning episode, at most once per episode,
 * ever.
 *
 * Two independent guards, and NEITHER is slice 2's one-active partial index -
 * that index stops holding the moment a row becomes terminal, so a redelivered
 * exhaustion event after a failed suspension would open a second one:
 *
 *   - the caller has already moved the episode to `suspension_requested` under a
 *     version CAS, and
 *   - the operation id is DERIVED from the episode id, so the operations primary
 *     key refuses a second insert permanently.
 *
 * Must run inside the caller's transaction, so the episode transition and the
 * operation appear together or not at all.
 */
export async function requestSuspension(
  store: Store,
  sub: SubscriptionRow,
  episodeId: string,
  now: number,
  actor: string,
): Promise<string | null> {
  if (!store.inTransaction()) {
    throw new Error("requestSuspension must run inside a transaction");
  }
  const opId = suspensionOperationId(episodeId);
  if (!sub.instance_id) {
    // Nothing to power off. Recorded rather than dropped: a paid-for subscription
    // with no box is itself something for a human to look at.
    await store.appendAudit({
      actor,
      instance_id: null,
      action: "suspension_requested",
      target: sub.id,
      outcome: "failed",
      detail:
        "no instance is linked to this subscription, so there is nothing to " +
        "power off; recorded for an operator",
    });
    return null;
  }
  if (await store.getOperation(opId)) {
    await store.appendAudit({
      actor,
      instance_id: sub.instance_id,
      action: "suspension_requested",
      target: opId,
      outcome: "succeeded",
      detail: "already open for this dunning episode; not enqueued twice",
    });
    return opId;
  }
  // The same deadline table the ticker uses, so an operation opened by billing is
  // indistinguishable from one the provisioning chain opened.
  const d = deadlinesFor("power_off");
  await store.enqueue({
    id: opId,
    instance_id: sub.instance_id,
    kind: "power_off",
    inactivity_deadline_at: now + d.inactivityMs,
    absolute_deadline_at: now + d.absoluteMs,
    evidence: { reason: "dunning", subscription: sub.id, episode: episodeId },
  });
  await store.appendAudit({
    actor,
    instance_id: sub.instance_id,
    action: "suspension_requested",
    target: opId,
    outcome: "started",
    detail: `dunning episode ${episodeId}`,
  });
  return opId;
}

export interface SuspensionDeps {
  /** Resolves when the provider reports the box off. Throws otherwise; the
   * ticker classifies the throw. */
  powerOff: (providerId: string) => Promise<void>;
  report?: (line: string) => void;
}

export function powerOffHandler(deps: SuspensionDeps): Handler {
  return {
    kind: "power_off",
    // A power action is a MUTATION: a killed call proves nothing about whether
    // the provider applied it, so a timeout is ambiguous rather than retryable.
    timeoutIsRetryable: false,
    async run(ctx: HandlerContext): Promise<HandlerResult> {
      const providerId = ctx.asset?.provider_id;
      if (!providerId) {
        // Deterministically wrong rather than retried: no amount of waiting gives
        // this instance a provider asset.
        return {
          kind: "fatal",
          reason:
            "cannot suspend an instance with no provider asset; there is nothing " +
            "to power off",
        };
      }
      ctx.budget.claim("power_off");
      await ctx.audit("power_off", "started", `provider ${providerId}`);
      try {
        await deps.powerOff(providerId);
      } catch (err) {
        // Rethrown for the ticker's classifier, which is the one place that
        // decides what a transport failure means. The audit row goes down here
        // because this is where we know the call was issued.
        await ctx.audit("power_off", "ambiguous", messageOf(err));
        throw err;
      }
      await ctx.audit("power_off", "succeeded", `provider ${providerId}`);
      deps.report?.(`suspended: provider ${providerId} powered off`);
      // `poweredOffAt` is written ON PURPOSE, and the cancellation timeline's
      // retention month is measured from it. A row timestamp would have been the
      // obvious substitute and is not one: `updated_at` and `evidence_at` are
      // metadata other writers may move, while this is a fact this handler
      // recorded at the instant it established it.
      //
      // THE OPENER'S STAMP IS CARRIED FORWARD. A done result REPLACES evidence
      // wholesale, so returning only these three fields would erase the `reason`
      // the opener wrote - and `reason` is what tells a dunning suspension
      // (resumable) from a cancellation one (never resumed). Same hazard the
      // mint handler documents for `via`.
      return {
        kind: "done",
        evidence: {
          ...openerStamp(ctx.op.evidence),
          poweredOff: true,
          providerId,
          poweredOffAt: ctx.now,
        },
      };
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The fields the OPENER put on the row that a completion must not lose.
 *
 * An allowlist rather than a spread of everything: evidence is ours, but only
 * these fields identify who opened the row, why, and which reboot facts a
 * corrective cancellation power-off answers. Copying the rest forward would
 * make a completion carry whatever a future opener happened to attach.
 * `graceEnd` and `retentionEnd` are opener projections only; no post-completion
 * decision reads them, so they are deliberately not carried.
 */
export function openerStamp(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const ev = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["reason", "subscription", "episode"]) {
    if (typeof ev[key] === "string") out[key] = ev[key];
  }
  if (typeof ev.correctiveFor === "string") {
    out.correctiveFor = ev.correctiveFor;
  }
  if (
    Array.isArray(ev.answeredReboots) &&
    ev.answeredReboots.every((id) => typeof id === "string")
  ) {
    out.answeredReboots = ev.answeredReboots;
  }
  return out;
}
