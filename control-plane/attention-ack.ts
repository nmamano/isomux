// "A human has seen it", and nothing else.
//
// This is one function in its own module for a reason that is structural rather
// than tidy. The ops floor runs inside the PUBLIC WEB APP, and the web app's
// module graph is fenced: it may not reach anything that can raise or clear
// attention, because a page that can raise attention can manufacture an incident
// and a page that can clear one can hide a real failure. Acknowledgement is
// neither - it is the least-privilege half of attention, and the only half an
// operator needs from a browser.
//
// So attention.ts stays graph-forbidden to the app with no exception, and this
// module - which imports the store and nothing else, and can express neither
// raise nor clear - is what ops.ts depends on. The boundary test walks the
// import graph, so an "it is convenient" import of attention.ts in here fails
// there rather than shipping.

import type { Store } from "./store.ts";

/**
 * Record that a human has seen this instance's open reasons.
 *
 * ACKNOWLEDGING IS NOT CLEARING. The reasons stay open, the instance stays
 * `needs_operator`, and only the underlying condition clears it. An ack that
 * cleared would let "I saw it" masquerade as "it is fixed", which is the one
 * thing an ops floor must never let a tired person do at 3am.
 *
 * Returns how many reasons it marked, so a caller can tell a real
 * acknowledgement from an acknowledgement of nothing.
 */
export function acknowledgeAttentionIn(
  store: Store,
  instanceId: string,
  by: string,
): number {
  if (!store.inTransaction()) {
    throw new Error("acknowledgeAttentionIn must run inside a transaction");
  }
  const n = store.acknowledgeReasons(instanceId, store.now(), by);
  // The instance's summary columns are a written summary of the open rows, so
  // they are recomputed inside this same transaction rather than left to drift
  // from the rows they summarise.
  const inst = store.getInstance(instanceId);
  if (!inst) throw new Error(`no instance ${instanceId} to acknowledge`);
  store.refreshAttentionSummary(instanceId, inst.version);
  store.appendAudit({
    actor: by,
    instance_id: instanceId,
    action: "acknowledge_attention",
    target: instanceId,
    outcome: "succeeded",
    detail: `${n} reason(s)`,
  });
  return n;
}

/**
 * The same, opening its own transaction. For callers that hold no other
 * invariant - the operator CLI.
 *
 * The ops floor uses the `In` form instead, because its authority check and its
 * write have to commit as one thing: a role read outside the transaction that
 * writes is a role that can be revoked between the check and the write.
 */
export function acknowledgeAttention(
  store: Store,
  instanceId: string,
  by: string,
): number {
  return store.tx(() => acknowledgeAttentionIn(store, instanceId, by));
}
