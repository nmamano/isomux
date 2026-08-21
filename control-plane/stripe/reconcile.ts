// Applying one Stripe event: the ONLY writer of the subscription cache.
//
// Everything here runs inside a transaction the CALLER owns, and the caller has
// already fetched the objects. That split is deliberate: the fetch is network
// I/O, and holding a write transaction open across it would keep its row locks
// and its connection for as long as one slow Stripe response takes. So the order is
// fetch-then-transaction, and the first thing this file does inside the
// transaction is RE-CHECK the event id, because a concurrent delivery of the same
// event could have landed while we were fetching.
//
// What commits together, or not at all: the event-id claim, the subscription
// cache, the instance's mirrored subscription state, the dunning episode
// transition, the suspension enqueue, the attention raise or clear, and the audit
// rows. A throw anywhere rolls back the claim too, so Stripe's redelivery of that
// event still has work to do.

import { isUniqueViolation, type Store } from "../store.ts";
import { raiseAttentionIn } from "../attention.ts";
import { CANCELLATION_POLICY_CUTOVER_KEY } from "../bootstrap.ts";
import { applyBillingAttention } from "./billing-attention.ts";
import {
  casEpisodeBookkeeping,
  casCancellationPolicy,
  casStripeOwnedSubscription,
  claimEvent,
  ensureAccount,
  eventSeen,
  getSubscription,
  insertSubscription,
  type SubscriptionRow,
} from "./billing-store.ts";
import { decide } from "./dunning.ts";
import { requestResume } from "../resume.ts";
import { requestSuspension } from "./suspension.ts";
import type {
  InvoiceSnapshot,
  SessionSnapshot,
  SubscriptionSnapshot,
} from "./shapes.ts";

import {
  META_ACCOUNT,
  META_EMAIL,
  META_INSTANCE,
  META_REINSTATEMENT,
} from "./metadata.ts";
import {
  attemptById,
  checkReinstatementEligibility,
  checkoutExpiryOperationId,
  currentSubscriptionForInstance,
  requestReinstatementPowerOn,
  type ReinstatementAttemptRow,
} from "../reinstatement.ts";
import {
  clearRefundRequired,
  raiseRefundRequired,
} from "../reinstatement-operations.ts";
import { reservationForInstance } from "../signup.ts";
import { startProvisioningIn } from "../provisioning-start.ts";

export const WEBHOOK_ACTOR = "stripe-webhook";

export interface ReconcileInput {
  eventId: string;
  eventType: string;
  /** Milliseconds. Stored as evidence only. */
  eventCreated: number;
  subscription: SubscriptionSnapshot;
  invoice?: InvoiceSnapshot | null;
  /** The fetched Checkout session, for the events that carry one. Linkage comes
   * from here or from the subscription's own metadata - never from a redirect. */
  session?: SessionSnapshot | null;
  now: number;
}

export type ReconcileOutcome =
  | {
      kind: "applied";
      subscriptionId: string;
      suspensionOpId: string | null;
      /** Set when this recovery also turned a suspended box back on. Null is the
       * normal answer: most recoveries have nothing to resume. */
      resumeOpId: string | null;
      note: string;
    }
  | { kind: "duplicate"; subscriptionId: string | null };

/**
 * Apply one event. MUST be called inside `store.tx`.
 *
 * Returns `duplicate` without writing anything when the event id is already in
 * the ledger, which is the durable dedupe: the id is a primary key, claimed in
 * this same transaction.
 */
export async function applyEvent(
  store: Store,
  input: ReconcileInput,
  report: (line: string) => void = () => {},
): Promise<ReconcileOutcome> {
  if (!store.inTransaction()) {
    throw new Error("applyEvent must run inside a transaction");
  }
  const already = await eventSeen(store, input.eventId);
  if (already) {
    return { kind: "duplicate", subscriptionId: already.subscription_id };
  }

  const row = await ensureRow(store, input, report);
  const decision = decide({
    row,
    subscription: input.subscription,
    invoice: input.invoice ?? null,
    eventId: input.eventId,
    eventType: input.eventType,
    eventCreated: input.eventCreated,
    now: input.now,
  });

  // The linkage the fetched objects assert. It travels with the Stripe-owned
  // patch because reconciliation is its only writer too.
  const linkage = await linkageFrom(store, input, row);
  const owned = { ...decision.stripeOwned, ...linkage.patch };

  const afterOwned = await casStripeOwnedSubscription(
    store,
    row.id,
    row.version,
    owned,
  );
  if (!afterOwned) {
    // Inside one transaction this can only mean a genuine concurrent writer, and
    // the right answer is to roll the whole thing back and let Stripe redeliver.
    throw new Error(
      `subscription ${row.id} moved while its Stripe snapshot was being applied`,
    );
  }

  let current: SubscriptionRow = afterOwned;
  let reinstatement: ReinstatementAttemptRow | null = null;
  if (linkage.reinstatementAttemptId) {
    await store.sqlRun(
      "update reinstatement_attempts set new_subscription_id=$1, state='accepted', updated_at=$2, version=version+1 where id=$3",
      [current.id, store.now(), linkage.reinstatementAttemptId],
    );
    reinstatement = await attemptById(store, linkage.reinstatementAttemptId);
  }
  if (
    row.cancel_at_period_end === 1 &&
    !input.subscription.cancelAtPeriodEnd &&
    input.subscription.endedAt === null
  ) {
    const reset = await casCancellationPolicy(
      store,
      current.id,
      current.version,
      {
        cancellation_policy: "launch",
      },
    );
    if (!reset)
      throw new Error(
        `subscription ${current.id} moved while its cancellation policy was reset`,
      );
    current = reset;
  }
  if (linkage.blockedInstanceId) {
    await raiseAttentionIn(store, {
      instanceId: linkage.blockedInstanceId,
      reasonClass: "operation_condition",
      sourceOpId: "",
      reason: `subscription ${current.id} was refused linkage to an instance that still contains prior-customer data`,
      severity: "critical",
      actor: WEBHOOK_ACTOR,
      detail: `event=${input.eventId}; observed=${new Date(input.now).toISOString()}`,
    });
  }
  if (Object.keys(decision.episode).length > 0) {
    const afterEpisode = await casEpisodeBookkeeping(
      store,
      current.id,
      current.version,
      decision.episode,
    );
    if (!afterEpisode) {
      throw new Error(
        `subscription ${current.id} moved while its dunning episode was being written`,
      );
    }
    current = afterEpisode;
  }

  await mirrorToInstance(store, current);

  const suspensionOpId = decision.suspension
    ? await requestSuspension(
        store,
        current,
        decision.suspension.episodeId,
        input.now,
        WEBHOOK_ACTOR,
      )
    : null;
  // The resume is a REQUEST that re-checks its own predicates against rows this
  // function cannot see - including the one that matters most, that a
  // cancellation-retention box is never powered back on. A refusal is the normal
  // outcome and is not an error: most recoveries have no suspended box.
  let resumeOpId: string | null = null;
  if (decision.resume) {
    const asked = await requestResume(store, current, input.now, WEBHOOK_ACTOR);
    if (asked.ok) {
      resumeOpId = asked.operationId;
      report(
        `resume requested for ${current.instance_id}: ${asked.operationId}`,
      );
    }
  }
  if (reinstatement) {
    const powerOn = await requestReinstatementPowerOn(
      store,
      reinstatement,
      current,
      store.now(),
    );
    if (powerOn) resumeOpId = powerOn;
    else
      await raiseRefundRequired(
        store,
        reinstatement,
        `subscription=${current.id}; power-on predicates failed; observed=${new Date(store.now()).toISOString()}`,
      );
  }
  await applyBillingAttention(
    store,
    current,
    decision.attention,
    WEBHOOK_ACTOR,
  );

  // Checkout is the latency edge. The cadence is the guarantee: it calls the
  // same gate from reconciled subscription state, including delayed settlement.
  // A fully discounted Checkout session was observed on 2026-08-09 to report
  // payment_status=paid too.
  if (
    input.eventType === "checkout.session.completed" &&
    input.session?.status === "complete" &&
    input.session.paymentStatus === "paid"
  ) {
    await startProvisioningIn(store, current);
  }

  await claimEvent(store, {
    id: input.eventId,
    type: input.eventType,
    created: input.eventCreated,
    subscription_id: current.id,
    outcome: "applied",
    detail: decision.note,
  });
  await store.appendAudit({
    actor: WEBHOOK_ACTOR,
    instance_id: current.instance_id,
    action: input.eventType,
    target: current.id,
    outcome: "succeeded",
    detail: decision.note,
  });

  return {
    kind: "applied",
    subscriptionId: current.id,
    suspensionOpId,
    resumeOpId,
    note: decision.note,
  };
}

/**
 * Record an event we understand but that changes nothing, so a redelivery is not
 * reprocessed and the ledger shows what arrived.
 */
export async function recordIgnoredEvent(
  store: Store,
  args: {
    eventId: string;
    eventType: string;
    eventCreated: number;
    note: string;
  },
): Promise<"recorded" | "duplicate"> {
  if (!store.inTransaction()) {
    throw new Error("recordIgnoredEvent must run inside a transaction");
  }
  if (await eventSeen(store, args.eventId)) return "duplicate";
  try {
    // The read above cannot decide this on its own: two deliveries of one event
    // can both find it unseen, and the primary key is what settles which of
    // them records it. RECOVERABLE because the claim is the only write in this
    // transaction, so the loser can answer exactly what it answered when the
    // previous engine serialised the two - "duplicate" - instead of failing a
    // delivery that has nothing left to do.
    await store.recoverable(() =>
      claimEvent(store, {
        id: args.eventId,
        type: args.eventType,
        created: args.eventCreated,
        subscription_id: null,
        outcome: "ignored",
        detail: args.note,
      }),
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    if (!(await eventSeen(store, args.eventId))) throw err;
    return "duplicate";
  }
  return "recorded";
}

// ----------------------------------------------------------------- helpers

/** The cache row for this subscription, created from the FETCHED object if this
 * is the first event we have applied for it. */
/**
 * The first row for a subscription, when two deliveries may both be making it.
 *
 * Both can read absent under read committed, and the primary key is what
 * decides. The loser reads the winner's row back and carries on with it, which
 * is what the previous engine's serialised writers gave for free: its second
 * transaction ran after the first had committed, so its own read found the row.
 */
async function insertFirstRow(
  store: Store,
  row: Parameters<typeof insertSubscription>[1],
): Promise<SubscriptionRow> {
  try {
    return await store.recoverable(() => insertSubscription(store, row));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await getSubscription(store, row.id);
    if (!winner) throw err;
    return winner;
  }
}

async function ensureRow(
  store: Store,
  input: ReconcileInput,
  report: (line: string) => void,
): Promise<SubscriptionRow> {
  const existing = await getSubscription(store, input.subscription.id);
  if (existing) return existing;
  // ...and if two deliveries for one subscription both read absent here, the
  // primary key settles it below, where the loser reads the winner's row back.

  const meta = {
    ...input.subscription.metadata,
    ...(input.session?.metadata ?? {}),
  };
  const email = meta[META_EMAIL];
  const accountId = meta[META_ACCOUNT];
  let account;
  if (accountId && email) {
    account = await ensureAccount(store, { id: accountId, email });
  } else {
    // An event for a subscription that carries none of our metadata - a manually
    // created test object, or a Stripe-generated fixture. It is still cached,
    // under an account that says plainly that nobody claimed it. Slice 4's signup
    // always sets the metadata, so this stays an exercise-time shape.
    const synthetic = `acct-unattributed-${input.subscription.customerId}`;
    report(
      `subscription ${input.subscription.id} carries no isomux metadata; ` +
        `caching it under an unattributed account`,
    );
    account = await ensureAccount(store, {
      id: synthetic,
      email: `${input.subscription.customerId}+unattributed@stripe.test`,
    });
  }

  return insertFirstRow(store, {
    id: input.subscription.id,
    account_id: account.id,
    instance_id: null,
    stripe_customer_id: input.subscription.customerId,
    // Deliberately a placeholder: the very next statement in applyEvent writes
    // the fetched status through the Stripe-owned setter, so there is exactly one
    // code path that ever decides what `status` says.
    status: "unknown",
    current_period_end: null,
    cancel_at_period_end: 0,
    ended_at: null,
    canceled_at: null,
    cancellation_reason: null,
    cancellation_policy: await policyForFirstRow(store, input.subscription),
    discount_percent_off: null,
    discount_coupon_id: null,
    discount_ends_at: null,
    ever_full_discount: 0,
    latest_invoice_id: null,
    payment_failures: 0,
    exhaustion_observed_at: null,
    coupon_grace_until: null,
    episode_id: null,
    last_event_id: null,
    last_event_created: null,
  });
}

/**
 * The instance this subscription pays for, when something authoritative says so.
 *
 * Never unset: a link is asserted by a fetched object, and its absence in a later
 * object is not a statement that the link is gone.
 */
async function policyForFirstRow(
  store: Store,
  snapshot: SubscriptionSnapshot,
): Promise<"legacy" | "launch"> {
  const cutover = await store.sqlGet<{ value: string }>(
    "select value from schema_meta where key = $1",
    [CANCELLATION_POLICY_CUTOVER_KEY],
  );
  const instant = Number(cutover?.value);
  if (!Number.isFinite(instant)) return "legacy";
  const anchors = [snapshot.canceledAt, snapshot.endedAt].filter(
    (value): value is number => value !== null,
  );
  const anchor = anchors.length > 0 ? Math.min(...anchors) : null;
  return anchor !== null && anchor < instant ? "legacy" : "launch";
}

async function linkageFrom(
  store: Store,
  input: ReconcileInput,
  row: SubscriptionRow,
): Promise<{
  patch: { instance_id?: string };
  blockedInstanceId: string | null;
  reinstatementAttemptId: string | null;
}> {
  if (row.instance_id)
    return { patch: {}, blockedInstanceId: null, reinstatementAttemptId: null };
  const meta = {
    ...input.subscription.metadata,
    ...(input.session?.metadata ?? {}),
  };
  const instanceId = meta[META_INSTANCE];
  if (!instanceId)
    return { patch: {}, blockedInstanceId: null, reinstatementAttemptId: null };
  const attemptId = meta[META_REINSTATEMENT];
  if (attemptId) {
    // This lock is shared with lifecycleTick. It makes linkage-versus-deletion
    // one serial answer rather than two successful half-transactions.
    const attempt = await store.sqlGet<ReinstatementAttemptRow>(
      "select * from reinstatement_attempts where id = $1 for update",
      [attemptId],
    );
    const reservation = await reservationForInstance(store, instanceId);
    const closed = attempt
      ? await getSubscription(store, attempt.closed_subscription_id)
      : null;
    const now = store.now();
    const noActivePower = attempt
      ? !(await store.operationsFor(attempt.instance_id)).some(
          (op) =>
            ["power_on", "power_off"].includes(op.kind) &&
            ["pending", "running", "ambiguous"].includes(op.status),
        )
      : false;
    const expiryStarted = attempt
      ? await store.getOperation(checkoutExpiryOperationId(attempt.id))
      : null;
    const eligibility =
      attempt && reservation && closed
        ? await checkReinstatementEligibility(store, {
            reservation,
            closed,
            now,
          })
        : null;
    const terminalRefusal =
      !attempt ||
      !reservation ||
      !closed ||
      attempt.state !== "pending" ||
      attempt.instance_id !== instanceId ||
      attempt.account_id !== row.account_id ||
      expiryStarted !== null ||
      now >= attempt.fence_expires_at ||
      eligibility?.ok !== true;
    const healthyStatus = ["active", "trialing"].includes(
      input.subscription.status,
    );
    if (!terminalRefusal && healthyStatus && noActivePower) {
      await clearRefundRequired(store, attempt);
      return {
        patch: { instance_id: instanceId },
        blockedInstanceId: null,
        reinstatementAttemptId: attempt.id,
      };
    }
    if (attempt && terminalRefusal) {
      await raiseRefundRequired(
        store,
        attempt,
        `subscription=${row.id}; linkage predicates failed; paymentStatus=${input.session?.paymentStatus ?? "unknown"}; observed=${new Date(now).toISOString()}`,
      );
    }
    return {
      patch: {},
      // The retained instance belongs to this same account. The generic
      // prior-customer-data incident is for cross-customer linkage only.
      blockedInstanceId: null,
      reinstatementAttemptId: null,
    };
  }
  // Subscription history is independent of the asset row. An INNER JOIN here
  // would fail open when the retained instance had no provider_assets row.
  const priorCancellation = await store.sqlGet<{ id: string }>(
    "select id from subscriptions where instance_id = $1 " +
      "and (cancel_at_period_end = 1 or ended_at is not null) limit 1",
    [instanceId],
  );
  const asset = await store.assetForInstance(instanceId);
  const forbidden =
    priorCancellation !== null ||
    asset?.asset_state === "cancel_scheduled" ||
    asset?.asset_state === "cancelled";
  return forbidden
    ? { patch: {}, blockedInstanceId: instanceId, reinstatementAttemptId: null }
    : {
        patch: { instance_id: instanceId },
        blockedInstanceId: null,
        reinstatementAttemptId: null,
      };
}

/** Slice 2 left `instances.subscription_state` as a stub column. This is the only
 * writer of it. */
async function mirrorToInstance(
  store: Store,
  sub: SubscriptionRow,
): Promise<void> {
  if (!sub.instance_id) return;
  const current = await currentSubscriptionForInstance(store, sub.instance_id);
  if (current?.id !== sub.id) return;
  const inst = await store.getInstance(sub.instance_id);
  if (!inst || inst.subscription_state === sub.status) return;
  if (
    !(await store.casInstance(inst.id, inst.version, {
      subscription_state: sub.status,
    }))
  ) {
    throw new Error(
      `instance ${inst.id} moved while its subscription state was being mirrored`,
    );
  }
}
