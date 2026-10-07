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
  /**
   * Extra evidence for the AUDIT ROW ONLY. Never part of the dedup identity.
   *
   * The identity is (sourceOpId, reason), so anything that moves - a provider's
   * date, an observation time - has to stay out of the reason or it opens a new
   * row on every reading. It still has to be recorded somewhere immutable, and
   * the audit log is that place: it is append-only, so a later renewal
   * overwriting `provider_assets.service_ends_at` cannot erase what the term
   * said when the incident was raised.
   */
  detail?: string;
  /**
   * Refuse the raise if this identity was EVER raised on the instance, cleared
   * or not. For a condition that cannot go away by itself: its scan keeps
   * seeing it, so without this an operator's resolve would reopen on the next
   * tick.
   */
  once?: boolean;
}

/** Must run inside a transaction the caller owns. */
export async function raiseAttentionIn(
  store: Store,
  args: RaiseArgs,
): Promise<boolean> {
  if (!store.inTransaction()) {
    throw new Error("raiseAttentionIn must run inside a transaction");
  }
  const sourceOpId = args.sourceOpId ?? "";
  const already = (await store.openReasons(args.instanceId)).some(
    (r) => r.source_op_id === sourceOpId && r.reason === args.reason,
  );
  if (already) return false;
  if (
    args.once &&
    (await store.sqlGet(
      "select 1 from attention_reasons where instance_id = $1 " +
        "and source_op_id = $2 and reason = $3 limit 1",
      [args.instanceId, sourceOpId, args.reason],
    ))
  ) {
    return false;
  }

  await store.insertReason({
    id: `att-${await store.nextSeq("audit")}-${sourceOpId || "none"}`,
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
  await summarise(store, args.instanceId);
  await store.appendAudit({
    actor: args.actor ?? "control-plane",
    instance_id: args.instanceId,
    action: "raise_attention",
    target: sourceOpId || args.instanceId,
    outcome: "started",
    detail: args.detail ? `${args.reason} [${args.detail}]` : args.reason,
  });
  return true;
}

/** Read the instance, then CAS its summary against exactly that read. */
async function summarise(store: Store, instanceId: string): Promise<void> {
  const inst = await store.getInstance(instanceId);
  if (!inst) throw new Error(`no instance ${instanceId} to summarise`);
  await store.refreshAttentionSummary(instanceId, inst.version);
}

export async function raiseAttention(
  store: Store,
  args: RaiseArgs,
): Promise<boolean> {
  return store.tx(() => raiseAttentionIn(store, args));
}

/** Clear ONE reason by id. Clearing is a statement about that condition, never
 * about the instance as a whole. */
export async function clearAttentionIn(
  store: Store,
  instanceId: string,
  reasonId: string,
  actor = "control-plane",
): Promise<void> {
  if (!store.inTransaction()) {
    throw new Error("clearAttentionIn must run inside a transaction");
  }
  await clearOne(store, instanceId, reasonId, actor, "clear_attention");
}

async function clearOne(
  store: Store,
  instanceId: string,
  reasonId: string,
  actor: string,
  action: string,
): Promise<void> {
  const row = (await store.openReasons(instanceId)).find(
    (r) => r.id === reasonId,
  );
  if (!row) return;
  if (!(await store.clearReason(reasonId, row.version, store.now()))) {
    throw new Error(
      `attention reason ${reasonId} moved while being cleared; re-read rather ` +
        `than overwriting the winner`,
    );
  }
  await summarise(store, instanceId);
  await store.appendAudit({
    actor,
    instance_id: instanceId,
    action,
    target: reasonId,
    outcome: "succeeded",
    detail: null,
  });
}

/**
 * An operator's statement that one condition has been dealt with: clear every
 * open row with this source id on the instance. Only for a condition nothing
 * clears by itself. A row whose condition can go away is cleared by that
 * condition, so resolving it by hand would only hide what is still true.
 *
 * Returns how many rows it resolved, so a caller can tell a resolve from a
 * resolve of nothing.
 */
export async function resolveAttentionIn(
  store: Store,
  instanceId: string,
  sourceOpId: string,
  by: string,
): Promise<number> {
  if (!store.inTransaction()) {
    throw new Error("resolveAttentionIn must run inside a transaction");
  }
  let n = 0;
  for (const open of await store.openReasons(instanceId)) {
    if (open.source_op_id !== sourceOpId) continue;
    await clearOne(store, instanceId, open.id, by, "resolve_attention");
    n++;
  }
  return n;
}

export async function clearAttention(
  store: Store,
  instanceId: string,
  reasonId: string,
  actor = "control-plane",
): Promise<void> {
  await store.tx(() => clearAttentionIn(store, instanceId, reasonId, actor));
}

// Acknowledgement used to live here and MOVED to attention-ack.ts in slice 5.
// Not a tidy-up: the ops floor runs inside the public web app, whose module
// graph may not reach anything able to raise or clear attention, and
// acknowledgement is the one half of this file an operator needs from a browser.
// Keeping all three together would have forced a graph exception that handed the
// app raise and clear as well. See attention-ack.ts.
