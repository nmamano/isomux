// Attention: persisted, orthogonal to service state, and never a side effect.
//
// A raise and its audit row commit TOGETHER. Writing the attention state into a
// database whose audit write just failed would leave the one durable record of
// why a human is needed missing from exactly the incident that needs it, so
// there is no arm here that persists half a transition.
//
// Every reason is its own row. The instance's attention columns are a written
// summary of the open rows, recomputed inside the same transaction - so an
// installer deadline cannot clear or overwrite an open revocation failure: it
// cannot reach that row, and the summary always names the worst still-open one.

import type { ReasonClass, Severity, Store } from "./store.ts";

export interface RaiseArgs {
  instanceId: string;
  /** WHAT the condition is, so clearing can be about the condition rather than
   * about whichever operation happened to raise it. */
  reasonClass: ReasonClass;
  /** The operation that produced it, or "" when the source is not an
   * operation. Empty rather than null: NULLs compare distinct in a unique
   * index, so a nullable column would let one reason be raised twice. */
  sourceOpId?: string;
  reason: string;
  severity: Severity;
  actor?: string;
}

/** Must run inside a transaction the caller owns. */
export function raiseAttentionIn(store: Store, args: RaiseArgs): boolean {
  if (!store.inTransaction()) {
    throw new Error("raiseAttentionIn must run inside a transaction");
  }
  const sourceOpId = args.sourceOpId ?? "";
  const already = store
    .openReasons(args.instanceId)
    .some((r) => r.source_op_id === sourceOpId && r.reason === args.reason);
  if (already) return false;

  store.insertReason({
    id: `att-${store.nextSeq("audit")}-${sourceOpId || "none"}`,
    instance_id: args.instanceId,
    source_op_id: sourceOpId,
    reason_class: args.reasonClass,
    reason: args.reason,
    severity: args.severity,
    raised_at: store.now(),
    cleared_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
  });
  summarise(store, args.instanceId);
  store.appendAudit({
    actor: args.actor ?? "control-plane",
    instance_id: args.instanceId,
    action: "raise_attention",
    target: sourceOpId || args.instanceId,
    outcome: "started",
    detail: args.reason,
  });
  return true;
}

/** Read the instance, then CAS its summary against exactly that read. */
function summarise(store: Store, instanceId: string): void {
  const inst = store.getInstance(instanceId);
  if (!inst) throw new Error(`no instance ${instanceId} to summarise`);
  store.refreshAttentionSummary(instanceId, inst.version);
}

export function raiseAttention(store: Store, args: RaiseArgs): boolean {
  return store.tx(() => raiseAttentionIn(store, args));
}

/** Clear ONE reason by id. Clearing is a statement about that condition, never
 * about the instance as a whole. */
export function clearAttentionIn(
  store: Store,
  instanceId: string,
  reasonId: string,
  actor = "control-plane",
): void {
  if (!store.inTransaction()) {
    throw new Error("clearAttentionIn must run inside a transaction");
  }
  const row = store.openReasons(instanceId).find((r) => r.id === reasonId);
  if (!row) return;
  if (!store.clearReason(reasonId, row.version, store.now())) {
    throw new Error(
      `attention reason ${reasonId} moved while being cleared; re-read rather ` +
        `than overwriting the winner`,
    );
  }
  summarise(store, instanceId);
  store.appendAudit({
    actor,
    instance_id: instanceId,
    action: "clear_attention",
    target: reasonId,
    outcome: "succeeded",
    detail: null,
  });
}

export function clearAttention(
  store: Store,
  instanceId: string,
  reasonId: string,
  actor = "control-plane",
): void {
  store.tx(() => clearAttentionIn(store, instanceId, reasonId, actor));
}

/**
 * Record that a human has seen the open reasons.
 *
 * Acknowledging is NOT clearing. The reasons stay open, the instance stays
 * `needs_operator`, and the underlying condition is what eventually clears it.
 * An ack that cleared would let "I saw it" masquerade as "it is fixed".
 */
export function acknowledgeAttention(
  store: Store,
  instanceId: string,
  by: string,
): number {
  return store.tx(() => {
    const n = store.acknowledgeReasons(instanceId, store.now(), by);
    summarise(store, instanceId);
    store.appendAudit({
      actor: by,
      instance_id: instanceId,
      action: "acknowledge_attention",
      target: instanceId,
      outcome: "succeeded",
      detail: `${n} reason(s)`,
    });
    return n;
  });
}
