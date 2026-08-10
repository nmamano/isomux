// Applying one Stripe event: the ONLY writer of the subscription cache.
//
// Everything here runs inside a transaction the CALLER owns, and the caller has
// already fetched the objects. That split is deliberate: the fetch is network
// I/O, and holding a SQLite write transaction open across it would let one slow
// Stripe response block every other writer. So the order is
// fetch-then-transaction, and the first thing this file does inside the
// transaction is RE-CHECK the event id, because a concurrent delivery of the same
// event could have landed while we were fetching.
//
// What commits together, or not at all: the event-id claim, the subscription
// cache, the instance's mirrored subscription state, the dunning episode
// transition, the suspension enqueue, the attention raise or clear, and the audit
// rows. A throw anywhere rolls back the claim too, so Stripe's redelivery of that
// event still has work to do.

import type { Store } from "../store.ts";
import { applyBillingAttention } from "./billing-attention.ts";
import {
  casEpisodeBookkeeping,
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

import { META_ACCOUNT, META_EMAIL, META_INSTANCE } from "./metadata.ts";

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
  const linkage = linkageFrom(input, row);
  const owned = { ...decision.stripeOwned, ...linkage };

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
  await applyBillingAttention(
    store,
    current,
    decision.attention,
    WEBHOOK_ACTOR,
  );

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
  await claimEvent(store, {
    id: args.eventId,
    type: args.eventType,
    created: args.eventCreated,
    subscription_id: null,
    outcome: "ignored",
    detail: args.note,
  });
  return "recorded";
}

// ----------------------------------------------------------------- helpers

/** The cache row for this subscription, created from the FETCHED object if this
 * is the first event we have applied for it. */
async function ensureRow(
  store: Store,
  input: ReconcileInput,
  report: (line: string) => void,
): Promise<SubscriptionRow> {
  const existing = await getSubscription(store, input.subscription.id);
  if (existing) return existing;

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

  return insertSubscription(store, {
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
function linkageFrom(
  input: ReconcileInput,
  row: SubscriptionRow,
): { instance_id?: string } {
  if (row.instance_id) return {};
  const meta = {
    ...input.subscription.metadata,
    ...(input.session?.metadata ?? {}),
  };
  const instanceId = meta[META_INSTANCE];
  return instanceId ? { instance_id: instanceId } : {};
}

/** Slice 2 left `instances.subscription_state` as a stub column. This is the only
 * writer of it. */
async function mirrorToInstance(
  store: Store,
  sub: SubscriptionRow,
): Promise<void> {
  if (!sub.instance_id) return;
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
