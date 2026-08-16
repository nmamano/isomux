// Cancel, and change your mind. The customer's two billing verbs.
//
// Shaped like requests.ts - ownership re-read inside the transaction, refusal
// codes with the customer's own words - but with one structural difference that
// matters more than the similarity: THIS ONE TALKS TO STRIPE, and the store must
// not be inside a transaction while it does. A write transaction held across a
// network call keeps its row locks, and its connection, for as long as Stripe
// takes to answer - which on a bad day is the timeout.
//
// So it is three phases:
//
//   1. A transaction that re-reads ownership, mints the idempotency key from the
//      audit sequence and WRITES THE STARTED ROW. Committed before any I/O, so
//      the key that will be sent is durable before it is used.
//   2. The Stripe call, with no store transaction open.
//   3. A transaction that records the outcome, honestly classified.
//
// WHY THE KEY IS PER-REQUEST AND NOT PER-SUBSCRIPTION. Stripe idempotency keys
// live 24 hours and REPLAY the original response. Cancel, un-cancel, cancel
// again inside one day is an ordinary thing for a customer to do, and with a
// fixed key the third call would replay the first response - reporting success
// while Stripe applied nothing and the subscription sat un-cancelled. A key per
// user-initiated request is what makes the third call a third call. It is safe
// because `cancel_at_period_end` is a STATE SET, not a create: two keys asking
// for the same end state produce that end state, whereas two keys asking to
// create a subscription produce two subscriptions.
//
// WE NEVER WRITE THE SUBSCRIPTION ROW. Webhooks stay the only writer of
// subscription state, so the dashboard says "we asked, waiting for Stripe" until
// `customer.subscription.updated` lands. That sentence is the truth, and a
// locally-flipped flag would be a guess that looks like a fact.

import { instanceOwnedBy } from "./signup.ts";
import type { StripeClient } from "./stripe/client.ts";
import type { SubscriptionRow } from "./stripe/billing-store.ts";
import { currentSubscriptionForInstance } from "./reinstatement.ts";
import type { Store } from "./store.ts";

export type CancelRefusal =
  | "not_yours"
  | "no_subscription"
  | "already_cancelled"
  | "not_cancelled"
  | "subscription_ended"
  | "stripe_unavailable"
  | "stripe_ambiguous";

/**
 * What the customer reads. Functional copy.
 *
 * `subscription_ended` deliberately does not offer to bring the office back: the
 * design says a resubscriber gets a new box unless the adapter proves otherwise,
 * so "contact support if you want your office back" would promise a recovery
 * nothing implements.
 */
export const CANCEL_REFUSAL_WORDS: Record<CancelRefusal, string> = {
  not_yours: "we could not find that office.",
  no_subscription: "we have no subscription for this office yet.",
  already_cancelled: "your subscription is already scheduled to end.",
  not_cancelled: "your subscription is not scheduled to end.",
  subscription_ended:
    "this subscription has ended, so it cannot be changed here. Contact support if you need help.",
  stripe_unavailable:
    "we could not reach our payment provider just now. Try again in a moment.",
  stripe_ambiguous:
    "we could not confirm your change with our payment provider. Check back in a moment before trying again.",
};

export type CancelOutcome =
  /** The request reached Stripe. `recorded` is false when the remote call
   * succeeded and our own outcome row did not - the caller must still treat it
   * as sent, or it would tell a customer nothing happened when something did. */
  | { ok: true; requestKey: string; recorded: boolean }
  | { ok: false; code: CancelRefusal; reason: string };

function refuse(code: CancelRefusal): CancelOutcome {
  return { ok: false, code, reason: CANCEL_REFUSAL_WORDS[code] };
}

export interface CancelRequest {
  accountId: string;
  instanceId: string;
}

type Verb = "cancel" | "uncancel";

interface Prepared {
  subscription: SubscriptionRow;
  requestKey: string;
}

/**
 * Phase 1: everything that must be true, and the durable key, in one commit.
 *
 * The audit row is written BEFORE the call rather than after it, which is the
 * only crash boundary available: a process that dies mid-call leaves a started
 * row with no outcome, and that is exactly the state a human needs to see.
 */
async function prepare(
  store: Store,
  req: CancelRequest,
  verb: Verb,
): Promise<Prepared | CancelOutcome> {
  return store.tx(async () => {
    if (!(await instanceOwnedBy(store, req.accountId, req.instanceId))) {
      return refuse("not_yours");
    }
    const row = await currentSubscriptionForInstance(store, req.instanceId);
    if (!row) return refuse("no_subscription");
    // A terminal subscription cannot be cancelled or reactivated. Stripe does
    // not un-delete one, so offering either would be a button that always fails.
    if (row.ended_at !== null) return refuse("subscription_ended");
    if (verb === "cancel" && row.cancel_at_period_end === 1) {
      return refuse("already_cancelled");
    }
    if (verb === "uncancel" && row.cancel_at_period_end === 0) {
      return refuse("not_cancelled");
    }
    const requestKey = `cp-${verb}-${await store.nextSeq("audit")}`;
    await store.appendAudit({
      actor: `account:${req.accountId}`,
      instance_id: req.instanceId,
      action: verb === "cancel" ? "request_cancel" : "request_uncancel",
      target: row.id,
      outcome: "started",
      // The KEY, so a started row with no outcome can be matched to the request
      // that may or may not have landed at Stripe.
      detail: requestKey,
    });
    return { subscription: row, requestKey };
  });
}

function isPrepared(v: Prepared | CancelOutcome): v is Prepared {
  return !("ok" in v);
}

async function apply(
  store: Store,
  client: StripeClient,
  req: CancelRequest,
  verb: Verb,
): Promise<CancelOutcome> {
  const prepared = await prepare(store, req, verb);
  if (!isPrepared(prepared)) return prepared;
  const { subscription, requestKey } = prepared;

  // NO TRANSACTION IS OPEN HERE. The client's own retry loop reuses this exact
  // key for the same logical request, which is what makes an ambiguous transport
  // a replay rather than a second request.
  const result = await client.post(
    `/v1/subscriptions/${encodeURIComponent(subscription.id)}`,
    { cancel_at_period_end: verb === "cancel" },
    requestKey,
  );

  const outcome =
    result.kind === "ok"
      ? "succeeded"
      : result.kind === "ambiguous"
        ? "ambiguous"
        : "failed";
  let recorded = true;
  try {
    // Awaited inside the try: the catch below is what turns a storage failure
    // into `recorded: false` rather than into a thrown request the customer is
    // told failed after Stripe already accepted it.
    await store.tx(() =>
      store.appendAudit({
        actor: `account:${req.accountId}`,
        instance_id: req.instanceId,
        action: verb === "cancel" ? "request_cancel" : "request_uncancel",
        target: subscription.id,
        outcome,
        detail: requestKey,
      }),
    );
  } catch {
    // THE CALL STILL HAPPENED. A storage failure here costs us history, not the
    // change: the webhook is what writes subscription state, and it does not
    // depend on this row. Reporting a failure because our own log write failed
    // would tell the customer nothing happened when something did.
    recorded = false;
  }

  if (result.kind === "ok") return { ok: true, requestKey, recorded };
  // An ambiguous transport MAY have applied the change. Its sentence says check
  // before retrying, because a customer who retries into a successful cancel
  // sees "already scheduled to end" and reasonably concludes we are broken.
  if (result.kind === "ambiguous") return refuse("stripe_ambiguous");
  return refuse("stripe_unavailable");
}

/** "Cancel my office" - schedule the subscription to end at the period end. */
export function requestCancel(
  store: Store,
  client: StripeClient,
  req: CancelRequest,
): Promise<CancelOutcome> {
  return apply(store, client, req, "cancel");
}

/** "Keep my office" - Stripe reactivation, available while the period is open. */
export function requestUncancel(
  store: Store,
  client: StripeClient,
  req: CancelRequest,
): Promise<CancelOutcome> {
  return apply(store, client, req, "uncancel");
}
