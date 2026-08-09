// Raising and clearing the operator-facing condition behind a billing event.
//
// Shared by webhook reconciliation and the coupon-hold deadline tick, so both
// express a billing condition the same way instead of each inventing one.
//
// Attention is per-INSTANCE by design ("attention_state ... on instances"), and a
// subscription that has not been linked to a box yet has nowhere to hang one. That
// case is audited rather than silently dropped, and slice 4 - which links a
// subscription to an instance at signup - is where it stops happening.

import { clearAttentionIn, raiseAttentionIn } from "../attention.ts";
import type { Store } from "../store.ts";
import type { SubscriptionRow } from "./billing-store.ts";

export type BillingAttention =
  | { kind: "raise"; reason: string; severity: "warning" | "critical" }
  | { kind: "clear" }
  | { kind: "none" };

/** Must run inside the caller's transaction: the condition and its audit row are
 * halves of one transition. */
export function applyBillingAttention(
  store: Store,
  sub: SubscriptionRow,
  attention: BillingAttention,
  actor: string,
): void {
  if (!store.inTransaction()) {
    throw new Error("applyBillingAttention must run inside a transaction");
  }
  if (attention.kind === "none") return;

  if (!sub.instance_id) {
    store.appendAudit({
      actor,
      instance_id: null,
      action:
        attention.kind === "raise"
          ? "billing_attention"
          : "billing_attention_cleared",
      target: sub.id,
      outcome: attention.kind === "raise" ? "failed" : "succeeded",
      detail:
        attention.kind === "raise"
          ? `${attention.reason} (no instance linked, so this is recorded rather than raised)`
          : "condition resolved",
    });
    return;
  }

  if (attention.kind === "raise") {
    raiseAttentionIn(store, {
      instanceId: sub.instance_id,
      // The SUBSCRIPTION is the source of this condition. Not an operation id and
      // not empty: keying on it is what lets a billing condition be cleared
      // without touching an open provisioning one.
      sourceOpId: sub.id,
      reasonClass: "operation_condition",
      reason: attention.reason,
      severity: attention.severity,
      actor,
    });
    return;
  }

  for (const reason of store.openReasons(sub.instance_id)) {
    if (reason.source_op_id !== sub.id) continue;
    clearAttentionIn(store, sub.instance_id, reason.id, actor);
  }
}
