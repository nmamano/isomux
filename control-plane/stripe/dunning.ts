// The dunning ladder, as pure functions of (cached row, fetched Stripe objects,
// now). No I/O, no store, no clock of its own - so every branch below is a unit
// test rather than a test-clock exercise.
//
// The one structure worth reading before the code is the DUNNING EPISODE.
//
// "Suspend at most once" cannot be expressed as "is there an active power_off
// row?", because slice 2's one-active index stops holding the moment that row
// becomes terminal: a redelivered exhaustion event after a failed suspension
// would open a second one. So a failure sequence gets a durable identity - the
// episode - and the suspension operation's id is DERIVED from it. The operations
// table's primary key then refuses a second insert permanently, terminal or not.
//
// The episode id is derived from the id of the event that OPENED the episode,
// which makes it deterministic under replay: the same opening event always
// computes the same episode, and therefore the same operation id. The episode is
// reset only by an authoritative recovery, so a genuine second failure sequence
// months later gets a new identity and may suspend again.

import type {
  EpisodePatch,
  StripeOwnedPatch,
  SubscriptionRow,
} from "./billing-store.ts";
import type { InvoiceSnapshot, SubscriptionSnapshot } from "./shapes.ts";

/**
 * The design's deadline on the couponed-account diversion: "14 days, then the
 * ordinary ladder resumes - or an unpaid office serves forever on the strength of
 * an unread notification."
 */
export const COUPON_HOLD_MS = 14 * 24 * 60 * 60 * 1000;

/** Stripe statuses that mean the customer is paid up. */
const HEALTHY = new Set(["active", "trialing"]);
/** Stripe statuses that mean an invoice went unpaid. */
const UNPAID = new Set(["past_due", "unpaid"]);

export interface LadderInputs {
  /** The cached row, or null when this event establishes it. */
  row: SubscriptionRow | null;
  /** Freshly fetched. Never an event payload. */
  subscription: SubscriptionSnapshot;
  /** Present for invoice events. */
  invoice?: InvoiceSnapshot | null;
  eventId: string;
  eventType: string;
  /** Milliseconds. Recorded as evidence; never used to order anything. */
  eventCreated: number;
  now: number;
}

export interface LadderDecision {
  stripeOwned: StripeOwnedPatch;
  episode: EpisodePatch;
  /** Set when this event is the one that asks for suspension. The caller enqueues
   * `suspensionOperationId(episodeId)` and nothing else. */
  suspension: { episodeId: string } | null;
  attention:
    | { kind: "raise"; reason: string; severity: "warning" | "critical" }
    | { kind: "clear" }
    | { kind: "none" };
  /** Classified, for the audit row. Never an object body. */
  note: string;
}

/**
 * The operation id for an episode's suspension.
 *
 * Deterministic on purpose: this string, and the operations primary key, are what
 * make "exactly once" a database property instead of a race we hope not to lose.
 */
export function suspensionOperationId(episodeId: string): string {
  return `op-power_off-${episodeId}`;
}

/**
 * Has Stripe given up retrying this invoice?
 *
 * ONE function, deliberately named, because it is a HYPOTHESIS ABOUT STRIPE'S
 * BEHAVIOUR and not a fact we control: an unpaid invoice with no
 * `next_payment_attempt` is Stripe saying it will not try again by itself.
 *
 * Observed 2026-08-09 on API version 2026-07-29.dahlia (slice 3 test-clock
 * exercise): see control-plane/README.md. If Stripe's shape changes, this
 * function is the only thing that has to change with it.
 */
export function observedExhaustion(
  invoice: InvoiceSnapshot | null | undefined,
  subscription: SubscriptionSnapshot,
): boolean {
  if (!invoice) return false;
  if (invoice.paid) return false;
  if (invoice.nextPaymentAttempt !== null) return false;
  // A draft invoice has not been attempted at all, so "no next attempt" says
  // nothing about retries being over.
  if (invoice.status === "draft") return false;
  return UNPAID.has(subscription.status) || invoice.status === "uncollectible";
}

/** Was this subscription ever fully discounted? Sticky, and it is what routes a
 * lapse to a human instead of into the ladder. */
function everFull(
  row: SubscriptionRow | null,
  snapshot: SubscriptionSnapshot,
): number {
  const nowFull = snapshot.discount?.percentOff === 100;
  return row?.ever_full_discount === 1 || nowFull ? 1 : 0;
}

/** A formerly-comped subscription with no active full discount right now. */
function isLapsedComp(
  row: SubscriptionRow | null,
  snapshot: SubscriptionSnapshot,
): boolean {
  return everFull(row, snapshot) === 1 && snapshot.discount?.percentOff !== 100;
}

/** What Stripe currently says, in the columns that cache it. */
function ownedFrom(
  inputs: LadderInputs,
  row: SubscriptionRow | null,
): StripeOwnedPatch {
  const s = inputs.subscription;
  return {
    status: s.status,
    current_period_end: s.currentPeriodEnd,
    cancel_at_period_end: s.cancelAtPeriodEnd ? 1 : 0,
    discount_percent_off: s.discount?.percentOff ?? null,
    discount_coupon_id: s.discount?.couponId ?? null,
    discount_ends_at: s.discount?.endsAt ?? null,
    ever_full_discount: everFull(row, s),
    latest_invoice_id: s.latestInvoiceId,
    last_event_id: inputs.eventId,
    last_event_created: inputs.eventCreated,
  };
}

export function decide(inputs: LadderInputs): LadderDecision {
  const { row, subscription, invoice, now } = inputs;
  const stripeOwned = ownedFrom(inputs, row);
  const state = row?.episode_state ?? "none";

  // ------------------------------------------------------------- recovery
  if (HEALTHY.has(subscription.status)) {
    if (state === "none" && (row?.payment_failures ?? 0) === 0) {
      return {
        stripeOwned,
        episode: {},
        suspension: null,
        attention: { kind: "none" },
        note: `${subscription.status} (no episode open)`,
      };
    }
    // An authoritative recovery is the ONLY thing that resets an episode, which
    // is what lets a genuine later failure sequence suspend again.
    return {
      stripeOwned,
      episode: {
        episode_state: "none",
        episode_id: null,
        payment_failures: 0,
        exhaustion_observed_at: null,
        coupon_grace_until: null,
      },
      suspension: null,
      attention: { kind: "clear" },
      note: `recovered to ${subscription.status}; dunning episode closed`,
    };
  }

  // ------------------------------------------------------ unpaid statuses
  if (UNPAID.has(subscription.status)) {
    const failures =
      inputs.eventType === "invoice.payment_failed"
        ? (row?.payment_failures ?? 0) + 1
        : (row?.payment_failures ?? 0);
    const exhausted = observedExhaustion(invoice, subscription);
    const exhaustionAt = exhausted
      ? (row?.exhaustion_observed_at ?? now)
      : (row?.exhaustion_observed_at ?? null);

    // A formerly-comped account never enters the ladder: the design routes it to
    // a human, with a deadline so an unread notification cannot become a free
    // office forever.
    if (state === "none" && isLapsedComp(row, subscription)) {
      return {
        stripeOwned,
        episode: {
          episode_state: "coupon_hold",
          episode_id: `dun-${inputs.eventId}`,
          payment_failures: failures,
          exhaustion_observed_at: exhaustionAt,
          coupon_grace_until: now + COUPON_HOLD_MS,
        },
        suspension: null,
        attention: {
          kind: "raise",
          reason:
            `a 100%-off coupon has lapsed and the next invoice went unpaid ` +
            `(${subscription.status}); this account needs a human, and the ` +
            `ordinary dunning ladder resumes in 14 days if nothing changes`,
          severity: "warning",
        },
        note: `coupon lapse: hold opened until ${new Date(now + COUPON_HOLD_MS).toISOString()}`,
      };
    }

    if (state === "none") {
      const episodeId = `dun-${inputs.eventId}`;
      // Exhaustion can arrive with the very first event we see, if we missed the
      // earlier ones - so opening an episode and requesting suspension in the
      // same decision has to be possible.
      if (exhausted) {
        return {
          stripeOwned,
          episode: {
            episode_state: "suspension_requested",
            episode_id: episodeId,
            payment_failures: failures,
            exhaustion_observed_at: exhaustionAt,
          },
          suspension: { episodeId },
          attention: {
            kind: "raise",
            reason: `Stripe has stopped retrying an unpaid invoice; suspension requested`,
            severity: "warning",
          },
          note: `dunning exhausted on first observation; suspension requested`,
        };
      }
      return {
        stripeOwned,
        episode: {
          episode_state: "open",
          episode_id: episodeId,
          payment_failures: failures,
          exhaustion_observed_at: exhaustionAt,
        },
        suspension: null,
        attention: { kind: "none" },
        note: `dunning episode opened (${subscription.status})`,
      };
    }

    if (state === "open") {
      if (exhausted && row?.episode_id) {
        return {
          stripeOwned,
          episode: {
            episode_state: "suspension_requested",
            payment_failures: failures,
            exhaustion_observed_at: exhaustionAt,
          },
          suspension: { episodeId: row.episode_id },
          attention: {
            kind: "raise",
            reason: `Stripe has stopped retrying an unpaid invoice; suspension requested`,
            severity: "warning",
          },
          note: `dunning exhausted after ${failures} failure(s); suspension requested`,
        };
      }
      return {
        stripeOwned,
        episode: {
          payment_failures: failures,
          exhaustion_observed_at: exhaustionAt,
        },
        suspension: null,
        attention: { kind: "none" },
        note: `dunning continues (${failures} failure(s), Stripe still retrying)`,
      };
    }

    if (state === "coupon_hold") {
      // The hold stands. Exhaustion evidence is RECORDED while it stands, so the
      // deadline pass can act on fact rather than on the hold expiring.
      return {
        stripeOwned,
        episode: {
          payment_failures: failures,
          exhaustion_observed_at: exhaustionAt,
        },
        suspension: null,
        attention: { kind: "none" },
        note: exhausted
          ? `coupon-lapse hold stands; Stripe has stopped retrying (recorded)`
          : `coupon-lapse hold stands`,
      };
    }

    // Already requested. Idempotent by construction: no second suspension, and
    // the derived operation id would be refused anyway.
    return {
      stripeOwned,
      episode: {
        payment_failures: failures,
        exhaustion_observed_at: exhaustionAt,
      },
      suspension: null,
      attention: { kind: "none" },
      note: `suspension already requested for this episode`,
    };
  }

  // ------------------------------------------- ended while owing money
  //
  // OBSERVED 2026-08-09 (slice 3, live test-clock exercise): on an account whose
  // failed-payment setting is "cancel subscription", Stripe's retry exhaustion
  // arrives as `customer.subscription.deleted` with
  // `cancellation_details.reason = "payment_failed"` - NOT as a lingering
  // `past_due`. So the suspension boundary is never reached on that setting, and a
  // ladder that only watched for unpaid statuses would leave a live box behind an
  // unpaid subscription with nobody told.
  //
  // No suspension is requested here: ending a service is cancellation, which is
  // slice 5's boundary, not this slice's. What this does is refuse to be silent -
  // the episode stays open as the record, and a human is told.
  if (
    (subscription.status === "canceled" ||
      subscription.status === "incomplete_expired") &&
    state !== "none"
  ) {
    return {
      stripeOwned,
      episode: {},
      suspension: null,
      attention: {
        kind: "raise",
        reason:
          `this subscription ended as ${subscription.status} with a dunning ` +
          `episode still open, so it went unpaid; the box is still running and ` +
          `deprovisioning is not built yet, which makes this a human's call`,
        severity: "critical",
      },
      note: `ended as ${subscription.status} with an open dunning episode`,
    };
  }

  // -------------------------------------------------- everything else
  // incomplete, paused, and a clean cancellation with no episode open: cached, no
  // ladder transition, nothing to tell anyone.
  return {
    stripeOwned,
    episode: {},
    suspension: null,
    attention: { kind: "none" },
    note: `status ${subscription.status}; no ladder transition`,
  };
}

export interface HoldExpiryDecision {
  episode: EpisodePatch;
  suspension: { episodeId: string } | null;
  attention:
    | { kind: "raise"; reason: string; severity: "warning" | "critical" }
    | { kind: "none" };
  note: string;
}

/**
 * What the expiry of a coupon-lapse hold does.
 *
 * The hold running out is NOT evidence that Stripe gave up. So expiry either acts
 * on exhaustion we have already observed, or it drops the account into the
 * ordinary ladder and waits for Stripe to say it is done retrying. It never
 * suspends on the strength of the calendar alone.
 */
export function decideHoldExpiry(
  row: SubscriptionRow,
  now: number,
): HoldExpiryDecision {
  if (row.episode_state !== "coupon_hold") {
    return {
      episode: {},
      suspension: null,
      attention: { kind: "none" },
      note: `not on a coupon-lapse hold`,
    };
  }
  if (row.coupon_grace_until === null || row.coupon_grace_until > now) {
    return {
      episode: {},
      suspension: null,
      attention: { kind: "none" },
      note: `hold has not expired`,
    };
  }
  const stillUnpaid = UNPAID.has(row.status);
  if (row.exhaustion_observed_at !== null && stillUnpaid && row.episode_id) {
    return {
      episode: { episode_state: "suspension_requested" },
      suspension: { episodeId: row.episode_id },
      attention: {
        kind: "raise",
        reason:
          `the 14-day hold on a lapsed 100%-off account has expired, Stripe has ` +
          `stopped retrying and the subscription is still ${row.status}; ` +
          `suspension requested`,
        severity: "warning",
      },
      note: `hold expired with exhaustion observed; suspension requested`,
    };
  }
  if (!stillUnpaid) {
    // Paid or cancelled in the meantime. The hold has nothing left to hold.
    return {
      episode: {
        episode_state: "none",
        episode_id: null,
        payment_failures: 0,
        exhaustion_observed_at: null,
        coupon_grace_until: null,
      },
      suspension: null,
      attention: { kind: "none" },
      note: `hold expired but the subscription is ${row.status}; episode closed`,
    };
  }
  return {
    episode: { episode_state: "open", coupon_grace_until: null },
    suspension: null,
    attention: {
      kind: "raise",
      reason:
        `the 14-day hold on a lapsed 100%-off account has expired and it is ` +
        `still ${row.status}; it is now in the ordinary dunning ladder, waiting ` +
        `for Stripe to finish retrying`,
      severity: "warning",
    },
    note: `hold expired without exhaustion evidence; ordinary ladder resumed`,
  };
}
