// The single gate that turns reconciled payment state into provisioning work.
//
// The webhook calls it for low latency. The provisioner's cadence calls it as
// a level-triggered repair for local Stripe state that arrived out of order or
// through an event that could not itself open the create. It cannot repair a
// subscription for which no Stripe event ever created a local row.

import { deadlinesFor, type OperationKind } from "./operations.ts";
import type { Store } from "./store.ts";
import type { SubscriptionRow } from "./stripe/billing-store.ts";

export const PROVISIONING_START_ACTOR = "provisioning-start";

export function runIdForSignup(instanceId: string): string {
  // Keep operator run ids distinct so ensureInstance cannot mutate a customer row.
  return `run-${instanceId.replace(/^inst-/, "")}`;
}

export function createOperationId(instanceId: string): string {
  return `op-create-${instanceId.replace(/^inst-/, "")}`;
}

/** Called inside the transaction that owns the subscription re-read. */
export async function startProvisioningIn(
  store: Store,
  subscription: SubscriptionRow,
): Promise<string | null> {
  if (!store.inTransaction()) {
    throw new Error("startProvisioningIn must run inside a transaction");
  }
  if (
    !subscription.instance_id ||
    !["active", "trialing"].includes(subscription.status)
  ) {
    return null;
  }
  const instance = await store.getInstance(subscription.instance_id);
  const reservation = await store.sqlGet<{ instance_id: string }>(
    "select instance_id from name_reservations where instance_id = $1",
    [subscription.instance_id],
  );
  const asset = await store.assetForInstance(subscription.instance_id);
  if (
    !instance ||
    !reservation ||
    !asset ||
    instance.service_state !== "provisioning" ||
    asset.provider_id !== null ||
    asset.asset_state !== "none"
  ) {
    return null;
  }
  // Any create row, including a terminal one, means this instance has already
  // spent its one attempt. The partial unique index arbitrates concurrent
  // first inserts; this read carries the permanent, terminal half of the rule.
  if (
    (await store.operationsFor(instance.id)).some(
      (operation) => operation.kind === "create_instance",
    )
  ) {
    return null;
  }
  const runId = runIdForSignup(instance.id);
  if (instance.run_id !== null && instance.run_id !== runId) return null;
  if (
    instance.run_id === null &&
    !(await store.casInstance(instance.id, instance.version, { run_id: runId }))
  ) {
    throw new Error(`instance ${instance.id} moved while provisioning opened`);
  }
  const id = createOperationId(instance.id);
  const deadlines = deadlinesFor("create_instance");
  await store.enqueue({
    id,
    instance_id: instance.id,
    kind: "create_instance",
    inactivity_deadline_at: store.now() + deadlines.inactivityMs,
    absolute_deadline_at: store.now() + deadlines.absoluteMs,
    evidence: { runId },
  });
  await store.appendAudit({
    actor: PROVISIONING_START_ACTOR,
    instance_id: instance.id,
    action: "open_create_instance",
    target: id,
    outcome: "started",
    detail: `subscription=${subscription.id}; run=${runId}`,
  });
  return id;
}

export async function sweepProvisioningStarts(
  store: Store,
  handles: (kind: OperationKind) => boolean,
): Promise<number> {
  // Do not spend the instance's permanent one-shot on a ticker that cannot
  // execute the paid call and its first provider-dependent successor.
  if (!handles("create_instance") || !handles("wait_for_address")) return 0;
  const candidates = await store.sqlAll<{ id: string }>(
    "select id from subscriptions where instance_id is not null " +
      "and status in ('active', 'trialing') order by created_at",
  );
  let opened = 0;
  for (const candidate of candidates) {
    const result = await store.tx(async () => {
      const current = await store.sqlGet<SubscriptionRow>(
        "select * from subscriptions where id = $1 for update",
        [candidate.id],
      );
      return current ? startProvisioningIn(store, current) : null;
    });
    if (result) opened++;
  }
  return opened;
}
