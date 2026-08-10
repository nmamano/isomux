// The ladder. Pure decisions, so every branch is a unit test rather than a month
// of waiting or a test clock.

import { describe, expect, test } from "bun:test";
import type { SubscriptionRow } from "./billing-store.ts";
import {
  COUPON_HOLD_MS,
  decide,
  decideHoldExpiry,
  observedExhaustion,
  suspensionOperationId,
} from "./dunning.ts";
import type { InvoiceSnapshot, SubscriptionSnapshot } from "./shapes.ts";

const NOW = 1_770_000_000_000;

function row(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub_1",
    account_id: "acct-1",
    instance_id: "inst-1",
    stripe_customer_id: "cus_1",
    status: "active",
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
    episode_state: "none",
    last_event_id: null,
    last_event_created: null,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function snapshot(
  over: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    endedAt: null,
    canceledAt: null,
    cancellationReason: null,
    discount: null,
    latestInvoiceId: null,
    metadata: {},
    livemode: false,
    ...over,
  };
}

function invoice(over: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: "in_1",
    subscriptionId: "sub_1",
    customerId: "cus_1",
    status: "open",
    amountDue: 550,
    attemptCount: 1,
    nextPaymentAttempt: NOW + 3 * 86_400_000,
    paid: false,
    livemode: false,
    ...over,
  };
}

function failure(args: {
  row: SubscriptionRow | null;
  subscription: SubscriptionSnapshot;
  invoice?: InvoiceSnapshot;
  eventId?: string;
}) {
  return decide({
    row: args.row,
    subscription: args.subscription,
    invoice: args.invoice ?? null,
    eventId: args.eventId ?? "evt_1",
    eventType: "invoice.payment_failed",
    eventCreated: NOW,
    now: NOW,
  });
}

describe("the exhaustion predicate", () => {
  test("an unpaid invoice with no next attempt, on an unpaid subscription", () => {
    expect(
      observedExhaustion(
        invoice({ nextPaymentAttempt: null }),
        snapshot({ status: "past_due" }),
      ),
    ).toBe(true);
  });

  test("a scheduled retry is not exhaustion", () => {
    expect(
      observedExhaustion(invoice(), snapshot({ status: "past_due" })),
    ).toBe(false);
  });

  test("a paid invoice is never exhaustion, whatever the schedule says", () => {
    expect(
      observedExhaustion(
        invoice({ paid: true, nextPaymentAttempt: null }),
        snapshot({ status: "past_due" }),
      ),
    ).toBe(false);
  });

  test("a draft invoice is not exhaustion: it was never attempted", () => {
    expect(
      observedExhaustion(
        invoice({ status: "draft", nextPaymentAttempt: null }),
        snapshot({ status: "past_due" }),
      ),
    ).toBe(false);
  });

  test("no invoice at all is not exhaustion", () => {
    expect(observedExhaustion(null, snapshot({ status: "past_due" }))).toBe(
      false,
    );
  });

  test("an uncollectible invoice counts even if the subscription reads active", () => {
    expect(
      observedExhaustion(
        invoice({ status: "uncollectible", nextPaymentAttempt: null }),
        snapshot({ status: "active" }),
      ),
    ).toBe(true);
  });
});

describe("the ordinary ladder", () => {
  test("a first failure opens an episode and suspends nothing", () => {
    const d = failure({
      row: row(),
      subscription: snapshot({ status: "past_due" }),
      invoice: invoice(),
    });
    expect(d.episode).toMatchObject({
      episode_state: "open",
      episode_id: "dun-evt_1",
      payment_failures: 1,
    });
    expect(d.suspension).toBeNull();
  });

  test("further failures count up while Stripe is still retrying", () => {
    const d = failure({
      row: row({
        episode_state: "open",
        episode_id: "dun-evt_1",
        payment_failures: 2,
      }),
      subscription: snapshot({ status: "past_due" }),
      invoice: invoice({ attemptCount: 3 }),
    });
    expect(d.episode.payment_failures).toBe(3);
    expect(d.suspension).toBeNull();
    expect(d.episode.episode_state).toBeUndefined();
  });

  test("exhaustion requests suspension for the OPEN episode's id", () => {
    const d = failure({
      row: row({
        episode_state: "open",
        episode_id: "dun-evt_1",
        payment_failures: 3,
      }),
      subscription: snapshot({ status: "past_due" }),
      invoice: invoice({ nextPaymentAttempt: null }),
      eventId: "evt_9",
    });
    expect(d.episode).toMatchObject({
      episode_state: "suspension_requested",
      exhaustion_observed_at: NOW,
    });
    // The episode's id, NOT this event's: a second exhaustion event for the same
    // episode must derive the same operation id.
    expect(d.suspension).toEqual({ episodeId: "dun-evt_1" });
    expect(suspensionOperationId("dun-evt_1")).toBe("op-power_off-dun-evt_1");
  });

  test("a second exhaustion event for the same episode asks for nothing more", () => {
    const d = failure({
      row: row({
        episode_state: "suspension_requested",
        episode_id: "dun-evt_1",
        payment_failures: 4,
        exhaustion_observed_at: NOW - 1000,
      }),
      subscription: snapshot({ status: "past_due" }),
      invoice: invoice({ nextPaymentAttempt: null }),
      eventId: "evt_10",
    });
    expect(d.suspension).toBeNull();
    // The first observation's timestamp stands; it is when Stripe gave up, not
    // when we heard about it again.
    expect(d.episode.exhaustion_observed_at).toBe(NOW - 1000);
  });

  test("exhaustion on the very first event we see opens and requests at once", () => {
    const d = failure({
      row: null,
      subscription: snapshot({ status: "past_due" }),
      invoice: invoice({ nextPaymentAttempt: null }),
      eventId: "evt_first",
    });
    expect(d.episode).toMatchObject({
      episode_state: "suspension_requested",
      episode_id: "dun-evt_first",
    });
    expect(d.suspension).toEqual({ episodeId: "dun-evt_first" });
  });
});

describe("the couponed diversion", () => {
  test("a lapsed 100%-off account holds instead of entering the ladder", () => {
    const d = failure({
      row: row({ ever_full_discount: 1 }),
      subscription: snapshot({ status: "past_due", discount: null }),
      invoice: invoice(),
    });
    expect(d.episode).toMatchObject({
      episode_state: "coupon_hold",
      coupon_grace_until: NOW + COUPON_HOLD_MS,
    });
    expect(d.suspension).toBeNull();
    expect(d.attention).toMatchObject({ kind: "raise", severity: "warning" });
  });

  test("the divert happens on the FIRST failure, not at exhaustion", () => {
    const d = failure({
      row: row({ ever_full_discount: 1 }),
      subscription: snapshot({ status: "past_due" }),
      // Stripe is still retrying: nothing about exhaustion has been observed.
      invoice: invoice(),
    });
    expect(d.episode.episode_state).toBe("coupon_hold");
  });

  test("a still-comped subscription is not a lapse", () => {
    const d = failure({
      row: row({ ever_full_discount: 1 }),
      subscription: snapshot({
        status: "past_due",
        discount: { couponId: "co_full", percentOff: 100, endsAt: null },
      }),
      invoice: invoice(),
    });
    expect(d.episode.episode_state).toBe("open");
  });

  test("an account that was never comped goes straight into the ladder", () => {
    const d = failure({
      row: row({ ever_full_discount: 0 }),
      subscription: snapshot({ status: "past_due" }),
      invoice: invoice(),
    });
    expect(d.episode.episode_state).toBe("open");
  });

  test("ever_full_discount is sticky once a full discount has been seen", () => {
    const first = decide({
      row: row(),
      subscription: snapshot({
        discount: { couponId: "co_full", percentOff: 100, endsAt: null },
      }),
      eventId: "evt_1",
      eventType: "customer.subscription.updated",
      eventCreated: NOW,
      now: NOW,
    });
    expect(first.stripeOwned.ever_full_discount).toBe(1);
    const later = decide({
      row: row({ ever_full_discount: 1 }),
      subscription: snapshot({ discount: null }),
      eventId: "evt_2",
      eventType: "customer.subscription.updated",
      eventCreated: NOW,
      now: NOW,
    });
    // The discount is gone; the memory of it is not.
    expect(later.stripeOwned.discount_percent_off).toBeNull();
    expect(later.stripeOwned.ever_full_discount).toBe(1);
  });

  test("exhaustion during the hold is RECORDED but does not suspend", () => {
    const d = failure({
      row: row({
        ever_full_discount: 1,
        episode_state: "coupon_hold",
        episode_id: "dun-evt_1",
        coupon_grace_until: NOW + COUPON_HOLD_MS,
      }),
      subscription: snapshot({ status: "past_due" }),
      invoice: invoice({ nextPaymentAttempt: null }),
    });
    expect(d.episode.exhaustion_observed_at).toBe(NOW);
    expect(d.suspension).toBeNull();
    expect(d.episode.episode_state).toBeUndefined();
  });
});

describe("recovery", () => {
  test("an authoritative return to active closes the episode and clears attention", () => {
    const d = decide({
      row: row({
        status: "past_due",
        episode_state: "suspension_requested",
        episode_id: "dun-evt_1",
        payment_failures: 4,
        exhaustion_observed_at: NOW - 1000,
      }),
      subscription: snapshot({ status: "active" }),
      eventId: "evt_ok",
      eventType: "customer.subscription.updated",
      eventCreated: NOW,
      now: NOW,
    });
    expect(d.episode).toEqual({
      episode_state: "none",
      episode_id: null,
      payment_failures: 0,
      exhaustion_observed_at: null,
      coupon_grace_until: null,
    });
    expect(d.attention).toEqual({ kind: "clear" });
  });

  test("a healthy subscription with no episode is left alone", () => {
    const d = decide({
      row: row(),
      subscription: snapshot({ status: "active" }),
      eventId: "evt_ok",
      eventType: "customer.subscription.updated",
      eventCreated: NOW,
      now: NOW,
    });
    expect(d.episode).toEqual({});
    expect(d.attention).toEqual({ kind: "none" });
  });

  test("a cancellation with an OPEN episode is cached and escalated to a human", () => {
    // OBSERVED 2026-08-09 live: on an account set to cancel at retry exhaustion,
    // this is how exhaustion actually arrives. Suspension is not requested -
    // ending a service is slice 5's boundary - but it must not pass in silence.
    const d = decide({
      row: row({
        status: "past_due",
        episode_state: "open",
        episode_id: "dun-1",
      }),
      subscription: snapshot({ status: "canceled" }),
      eventId: "evt_gone",
      eventType: "customer.subscription.deleted",
      eventCreated: NOW,
      now: NOW,
    });
    expect(d.stripeOwned.status).toBe("canceled");
    expect(d.episode).toEqual({});
    expect(d.suspension).toBeNull();
    expect(d.attention).toMatchObject({ kind: "raise", severity: "critical" });
  });

  test("a cancellation with NO episode open says nothing", () => {
    const d = decide({
      row: row({ status: "active" }),
      subscription: snapshot({ status: "canceled" }),
      eventId: "evt_bye",
      eventType: "customer.subscription.deleted",
      eventCreated: NOW,
      now: NOW,
    });
    expect(d.attention).toEqual({ kind: "none" });
    expect(d.stripeOwned.status).toBe("canceled");
  });
});

describe("the hold expiring", () => {
  test("with exhaustion observed and still unpaid, it requests suspension", () => {
    const d = decideHoldExpiry(
      row({
        status: "past_due",
        episode_state: "coupon_hold",
        episode_id: "dun-evt_1",
        coupon_grace_until: NOW - 1,
        exhaustion_observed_at: NOW - 86_400_000,
      }),
      NOW,
    );
    expect(d.episode).toEqual({ episode_state: "suspension_requested" });
    expect(d.suspension).toEqual({ episodeId: "dun-evt_1" });
  });

  test("without exhaustion evidence it resumes the ordinary ladder and WAITS", () => {
    // The calendar is not evidence that Stripe gave up. This is the branch that
    // must not suspend.
    const d = decideHoldExpiry(
      row({
        status: "past_due",
        episode_state: "coupon_hold",
        episode_id: "dun-evt_1",
        coupon_grace_until: NOW - 1,
        exhaustion_observed_at: null,
      }),
      NOW,
    );
    expect(d.episode).toEqual({
      episode_state: "open",
      coupon_grace_until: null,
    });
    expect(d.suspension).toBeNull();
    expect(d.attention).toMatchObject({ kind: "raise" });
  });

  test("a subscription that got paid in the meantime just closes its episode", () => {
    const d = decideHoldExpiry(
      row({
        status: "active",
        episode_state: "coupon_hold",
        episode_id: "dun-evt_1",
        coupon_grace_until: NOW - 1,
        exhaustion_observed_at: NOW - 10,
      }),
      NOW,
    );
    expect(d.episode.episode_state).toBe("none");
    expect(d.suspension).toBeNull();
  });

  test("a hold that has not expired does nothing", () => {
    const d = decideHoldExpiry(
      row({
        status: "past_due",
        episode_state: "coupon_hold",
        episode_id: "dun-evt_1",
        coupon_grace_until: NOW + 1,
        exhaustion_observed_at: NOW,
      }),
      NOW,
    );
    expect(d.episode).toEqual({});
    expect(d.suspension).toBeNull();
  });

  test("a row that is not on a hold does nothing", () => {
    const d = decideHoldExpiry(
      row({ episode_state: "open", coupon_grace_until: NOW - 1 }),
      NOW,
    );
    expect(d.episode).toEqual({});
  });
});
