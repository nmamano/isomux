// The cancellation timeline's driver: one pass, no sleeps, nothing invented.
//
// Same shape as billing-tick.ts, and for the same reasons - the outer scan runs
// with no transaction open, so every decision is recomputed from a row re-read
// INSIDE the transaction that writes, and the summary counts only what
// committed. A pass that printed from inside the transaction could claim a
// transition a failed COMMIT rolled back.
//
// It acts about twice in a customer's entire life: once at the end of the grace
// week, and once at the retention deadline. Everything else is a read.

import { clearAttentionIn, raiseAttentionIn } from "./attention.ts";
import { deadlinesFor } from "./operations.ts";
import { decideLifecycle, type LifecyclePhase } from "./lifecycle.ts";
import type { Store } from "./store.ts";
import type { SubscriptionRow } from "./stripe/billing-store.ts";

export const LIFECYCLE_TICK_ACTOR = "lifecycle-tick";

export interface LifecycleTickSummary {
  examined: number;
  opened: number;
  finished: number;
  raised: number;
  /** Conditions that went away. Counted separately from raises so a pass that
   * resolved something reads differently from one that found nothing. */
  cleared: number;
  phases: Record<string, number>;
}

/**
 * Subscriptions a cancellation could be about at all.
 *
 * WIDER THAN "ended_at is not null" on purpose. A merely-scheduled cancellation
 * has nothing for this machine to do, and decideLifecycle says so in one
 * comparison - but the defensive arm that catches lifecycle rows on a
 * subscription that is NOT terminal can only fire if such a subscription is
 * examined. Narrowing the scan to terminal rows would have made that arm
 * unreachable, which is the same as not having written it.
 */
async function cancelledSubscriptions(
  store: Store,
): Promise<SubscriptionRow[]> {
  return store.sqlAll<SubscriptionRow>(
    "select * from subscriptions where instance_id is not null " +
      "and (ended_at is not null or cancellation_reason is not null) " +
      "order by ended_at",
  );
}

export async function lifecycleTick(
  store: Store,
  now: number = store.now(),
  report: (line: string) => void = () => {},
): Promise<LifecycleTickSummary> {
  const summary: LifecycleTickSummary = {
    examined: 0,
    opened: 0,
    finished: 0,
    raised: 0,
    cleared: 0,
    phases: {},
  };

  for (const scanned of await cancelledSubscriptions(store)) {
    summary.examined++;
    let committed: {
      opened: string[];
      finished: boolean;
      raised: boolean;
      cleared: number;
      phase: LifecyclePhase;
      note: string;
    } | null = null;
    try {
      // Awaited inside the try: the catch below is what keeps one failing
      // subscription from ending the whole pass.
      committed = await store.tx(async () => {
        // RE-READ AND RE-DECIDE. A webhook can move this subscription between
        // the scan and here, and the field that moves is the one that decides
        // whether somebody's box gets powered off.
        const sub = await store.sqlGet<SubscriptionRow>(
          "select * from subscriptions where id = $1",
          [scanned.id],
        );
        // Deliberately NOT short-circuiting on a null ended_at. decideLifecycle
        // is what decides that a non-terminal subscription is not this
        // machine's business - and it is also what notices the one case where
        // that is alarming rather than ordinary.
        if (!sub || !sub.instance_id) return null;
        const instance = await store.getInstance(sub.instance_id);
        if (!instance) return null;

        const decision = decideLifecycle({
          instance,
          asset: await store.assetForInstance(instance.id),
          operations: await store.operationsFor(instance.id),
          subscription: {
            id: sub.id,
            endedAt: sub.ended_at,
            cancellationReason: sub.cancellation_reason,
            cancellationPolicy: sub.cancellation_policy,
          },
          now,
        });

        const opened: string[] = [];
        for (const spec of decision.open) {
          if (spec.kind === "power_off") {
            for (const reboot of await store.operationsFor(instance.id)) {
              if (reboot.kind !== "reboot" || reboot.status !== "pending")
                continue;
              await store.sqlRun(
                "update operations set status = 'failed', evidence = $1, " +
                  "evidence_at = $2, updated_at = $2, version = version + 1 " +
                  "where id = $3 and status = 'pending'",
                [
                  JSON.stringify({
                    reason: "superseded_by_cancellation",
                    powerOffOperation: spec.id,
                  }),
                  now,
                  reboot.id,
                ],
              );
            }
          }
          // getOperation, not the one-active index, is the arbiter here: the id
          // is derived, so a row that already exists in ANY status - including a
          // terminal one - means this rung has been walked and must not be
          // walked twice. The index alone stops holding the moment a row goes
          // terminal, which is the exact hole suspension.ts documents.
          if (await store.getOperation(spec.id)) continue;
          const d = deadlinesFor(spec.kind);
          await store.enqueue({
            id: spec.id,
            instance_id: instance.id,
            kind: spec.kind,
            inactivity_deadline_at: now + d.inactivityMs,
            absolute_deadline_at: now + d.absoluteMs,
            evidence: spec.evidence,
          });
          await store.appendAudit({
            actor: LIFECYCLE_TICK_ACTOR,
            instance_id: instance.id,
            action: `lifecycle_${spec.kind}`,
            target: spec.id,
            outcome: "started",
            detail: decision.note,
          });
          opened.push(spec.id);
        }

        let finished = false;
        if (decision.finish) {
          // The data end, and the ONE place it is recorded. Provider truth said
          // the asset is gone; our deadline passing never says that.
          if (
            !(await store.casInstance(instance.id, instance.version, {
              service_state: "deprovisioned",
            }))
          ) {
            throw new Error(
              `instance ${instance.id} moved while its data end was being recorded`,
            );
          }
          await store.appendAudit({
            actor: LIFECYCLE_TICK_ACTOR,
            instance_id: instance.id,
            action: "data_end",
            target: instance.id,
            outcome: "succeeded",
            detail: decision.note,
          });
          finished = true;
        }

        // IN ORDER, IN THIS TRANSACTION. A promotion is a clear followed by a
        // raise, and the two committing separately would leave a superseded
        // instruction on the ops floor beside the incident that replaced it.
        let raised = false;
        let cleared = 0;
        for (const action of decision.attention) {
          if (action.kind === "raise") {
            // sourceOpId is the condition's KEY, so a second tick observing the
            // same thing is refused by the open-reason unique index instead of
            // opening another critical row. The dated evidence rides in the
            // audit detail, never in the identity.
            raised =
              (await raiseAttentionIn(store, {
                instanceId: instance.id,
                reasonClass: "operation_condition",
                sourceOpId: action.key,
                reason: action.reason,
                severity: action.severity,
                actor: LIFECYCLE_TICK_ACTOR,
                ...(action.detail ? { detail: action.detail } : {}),
              })) || raised;
            continue;
          }
          // ONLY the keyed condition, and only that one. A broken promise is
          // irreversible and carries a different key, so nothing here can
          // clear it.
          for (const open of await store.openReasons(instance.id)) {
            if (open.source_op_id !== action.key) continue;
            await clearAttentionIn(
              store,
              instance.id,
              open.id,
              LIFECYCLE_TICK_ACTOR,
            );
            cleared++;
          }
        }

        return {
          opened,
          finished,
          raised,
          cleared,
          phase: decision.phase,
          note: decision.note,
        };
      });
    } catch (err) {
      report(`lifecycle ${scanned.id} failed: ${messageOf(err)}`);
      continue;
    }
    if (!committed) continue;
    summary.opened += committed.opened.length;
    if (committed.finished) summary.finished++;
    if (committed.raised) summary.raised++;
    summary.cleared += committed.cleared;
    summary.phases[committed.phase] =
      (summary.phases[committed.phase] ?? 0) + 1;
    for (const id of committed.opened) report(`opened ${id}`);
    if (committed.finished) report(`${scanned.instance_id}: data end recorded`);
  }

  return summary;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
