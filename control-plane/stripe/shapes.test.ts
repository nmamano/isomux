// Normalising Stripe objects, including the fields the pinned API version moved.
//
// These are SYNTHETIC objects, deliberately: the point is to hold both the new
// and the old shape at once, which no single live response can do.

import { describe, expect, test } from "bun:test";
import {
  MalformedStripeObject,
  normalizeInvoice,
  normalizeSession,
  normalizeSubscription,
} from "./shapes.ts";

const PERIOD_END_SEC = 1_772_000_000;

describe("a subscription's period end", () => {
  test("comes from the subscription ITEM, where the pinned version puts it", async () => {
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      items: { data: [{ current_period_end: PERIOD_END_SEC }] },
    });
    expect(snap.currentPeriodEnd).toBe(PERIOD_END_SEC * 1000);
  });

  test("falls back to the top-level field, for an older pin", async () => {
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      current_period_end: PERIOD_END_SEC,
    });
    expect(snap.currentPeriodEnd).toBe(PERIOD_END_SEC * 1000);
  });

  test("takes the latest item period when there are several", async () => {
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      items: {
        data: [
          { current_period_end: PERIOD_END_SEC },
          { current_period_end: PERIOD_END_SEC + 86_400 },
        ],
      },
    });
    expect(snap.currentPeriodEnd).toBe((PERIOD_END_SEC + 86_400) * 1000);
  });

  test("is null when the object carries no period at all", async () => {
    expect(
      normalizeSubscription({
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        livemode: false,
      }).currentPeriodEnd,
    ).toBeNull();
  });
});

describe("a subscription's currency", () => {
  test("is the subscription's own, not its item price's default currency", async () => {
    // A price with a EUR currency option still says `usd` on the item: that is
    // the price's default, not what this euro-area customer pays.
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      currency: "eur",
      items: { data: [{ price: { id: "price_1", currency: "usd" } }] },
    });
    expect(snap.currency).toBe("eur");
  });

  test("is null when the object carries none, never read off the item", async () => {
    expect(
      normalizeSubscription({
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        livemode: false,
        items: { data: [{ price: { id: "price_1", currency: "usd" } }] },
      }).currency ?? null,
    ).toBeNull();
  });
});

// Task 644649b3: the price-against-plan check reads the item price as Stripe
// states it - the price's own unit_amount and default currency, which is what
// identifies the Price, whatever currency option the customer pays in.
describe("a subscription's item price", () => {
  const sub = (items: unknown) =>
    normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      currency: "eur",
      ...(items === undefined ? {} : { items }),
    }).itemPrice;

  test("one item with a unit amount is that amount in the price's own currency", () => {
    expect(
      sub({
        data: [{ price: { id: "price_1", currency: "usd", unit_amount: 900 } }],
      }),
    ).toEqual({ kind: "single", unitAmount: 900, currency: "usd" });
  });

  test("any other shape is recorded as other, never as a guess", () => {
    const price = (unit_amount: unknown) => ({
      price: { id: "price_1", currency: "eur", unit_amount },
    });
    for (const items of [
      { data: [] },
      { data: [price(800), price(1700)] },
      { data: [price(null)] },
      { data: [{ price: { id: "price_1", currency: "eur" } }] },
      { data: [price(800.5)] },
      { data: [{ price: { id: "price_1", unit_amount: 800 } }] },
    ]) {
      expect([items, sub(items)]).toEqual([items, { kind: "other" }]);
    }
  });

  test("an object without an items list records nothing", () => {
    expect(sub(undefined)).toBeUndefined();
  });
});

describe("a subscription's discount", () => {
  test("comes through discount.source.coupon, the shape the pinned version returns", async () => {
    // OBSERVED 2026-08-09 on 2026-07-29.dahlia: this is the real shape of a coupon
    // applied at Checkout, fetched with expand[]=discounts.source.coupon.
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      discounts: [
        {
          id: "di_1",
          object: "discount",
          end: PERIOD_END_SEC,
          source: {
            type: "coupon",
            coupon: {
              id: "co_full",
              object: "coupon",
              percent_off: 100,
              duration: "repeating",
              duration_in_months: 1,
            },
          },
        },
      ],
    });
    expect(snap.discount).toEqual({
      couponId: "co_full",
      percentOff: 100,
      endsAt: PERIOD_END_SEC * 1000,
    });
  });

  test("an UNEXPANDED discount is a hard stop, never read as 'no discount'", async () => {
    // Reading an unexpanded discount as absence would tell the ladder that a comped
    // subscription is no longer comped - the wrong answer, silently.
    for (const discounts of [
      ["di_1"],
      [
        {
          id: "di_1",
          end: null,
          source: { type: "coupon", coupon: "co_full" },
        },
      ],
    ]) {
      expect(() =>
        normalizeSubscription({
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          livemode: false,
          discounts,
        }),
      ).toThrow(MalformedStripeObject);
    }
  });

  test("an amount-off coupon has a null percentage, which is NOT unknown", async () => {
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      discounts: [
        {
          id: "di_1",
          end: null,
          source: {
            type: "coupon",
            coupon: { id: "co_five_off", percent_off: null, amount_off: 500 },
          },
        },
      ],
    });
    expect(snap.discount).toEqual({
      couponId: "co_five_off",
      percentOff: null,
      endsAt: null,
    });
  });

  test("the older discounts[].coupon shape still works", async () => {
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      discounts: [
        {
          id: "di_1",
          coupon: { id: "co_full", percent_off: 100 },
          end: PERIOD_END_SEC,
        },
      ],
    });
    expect(snap.discount).toEqual({
      couponId: "co_full",
      percentOff: 100,
      endsAt: PERIOD_END_SEC * 1000,
    });
  });

  test("falls back to the singular discount field", async () => {
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      discount: { coupon: { id: "co_half", percent_off: 50 }, end: null },
    });
    expect(snap.discount).toEqual({
      couponId: "co_half",
      percentOff: 50,
      endsAt: null,
    });
  });

  test("keeps the largest percentage when Stripe reports several", async () => {
    const snap = normalizeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      livemode: false,
      discounts: [
        { id: "di_1", coupon: { id: "co_small", percent_off: 10 } },
        { id: "di_2", coupon: { id: "co_full", percent_off: 100 } },
      ],
    });
    expect(snap.discount?.couponId).toBe("co_full");
  });

  test("is null when there is none", async () => {
    expect(
      normalizeSubscription({
        id: "sub_1",
        customer: "cus_1",
        status: "past_due",
        livemode: false,
        discounts: [],
      }).discount,
    ).toBeNull();
  });
});

describe("an invoice's subscription", () => {
  test("comes from parent.subscription_details, where the pinned version puts it", async () => {
    const snap = normalizeInvoice({
      id: "in_1",
      status: "open",
      livemode: false,
      parent: { subscription_details: { subscription: "sub_9" } },
    });
    expect(snap.subscriptionId).toBe("sub_9");
  });

  test("falls back to the top-level subscription field", async () => {
    expect(
      normalizeInvoice({
        id: "in_1",
        status: "open",
        livemode: false,
        subscription: "sub_8",
      }).subscriptionId,
    ).toBe("sub_8");
  });

  test("is null for a one-off invoice", async () => {
    expect(
      normalizeInvoice({ id: "in_1", status: "paid", livemode: false })
        .subscriptionId,
    ).toBeNull();
  });

  test("is settled without a `paid` boolean, which the pinned version omits", async () => {
    // OBSERVED 2026-08-09 on 2026-07-29.dahlia: invoices carry no `paid` field.
    // Reading it alone called every invoice unpaid.
    expect(
      normalizeInvoice({
        id: "in_1",
        status: "paid",
        livemode: false,
        amount_due: 100,
        amount_remaining: 0,
      }).paid,
    ).toBe(true);
    expect(
      normalizeInvoice({
        id: "in_2",
        status: "open",
        livemode: false,
        amount_due: 100,
        amount_remaining: 100,
      }).paid,
    ).toBe(false);
    // An older pin's boolean still wins where it exists.
    expect(
      normalizeInvoice({
        id: "in_3",
        status: "open",
        livemode: false,
        paid: true,
      }).paid,
    ).toBe(true);
  });

  test("carries the retry evidence the ladder reads", async () => {
    const snap = normalizeInvoice({
      id: "in_1",
      status: "open",
      livemode: false,
      attempt_count: 3,
      next_payment_attempt: null,
      paid: false,
      amount_due: 550,
    });
    expect(snap).toMatchObject({
      attemptCount: 3,
      nextPaymentAttempt: null,
      paid: false,
      amountDue: 550,
    });
  });
});

describe("livemode", () => {
  test("a missing livemode is MALFORMED, not assumed to be test mode", async () => {
    // Treating absence as false is exactly how live data would slip through.
    expect(() =>
      normalizeSubscription({
        id: "sub_1",
        customer: "cus_1",
        status: "active",
      }),
    ).toThrow(MalformedStripeObject);
  });

  test("a non-boolean livemode is malformed too", async () => {
    expect(() =>
      normalizeInvoice({ id: "in_1", status: "open", livemode: "false" }),
    ).toThrow(MalformedStripeObject);
  });

  test("live mode is carried through, for the refusal above to act on", async () => {
    expect(normalizeSession({ id: "cs_1", livemode: true }).livemode).toBe(
      true,
    );
  });
});

describe("required fields", () => {
  test("a subscription with no id, status or customer is malformed", async () => {
    expect(() => normalizeSubscription({ livemode: false })).toThrow(
      MalformedStripeObject,
    );
    expect(() =>
      normalizeSubscription({ id: "sub_1", livemode: false }),
    ).toThrow(MalformedStripeObject);
    expect(() =>
      normalizeSubscription({ id: "sub_1", status: "active", livemode: false }),
    ).toThrow(MalformedStripeObject);
  });

  test("a session reports what Checkout decided about collecting a card", async () => {
    const snap = normalizeSession({
      id: "cs_1",
      livemode: false,
      status: "complete",
      payment_status: "no_payment_required",
      payment_method_collection: "if_required",
      subscription: { id: "sub_1" },
      metadata: { isomux_account: "acct-1", n: 5 },
    });
    expect(snap).toMatchObject({
      subscriptionId: "sub_1",
      paymentStatus: "no_payment_required",
      paymentMethodCollection: "if_required",
    });
    // Non-string metadata is dropped rather than coerced: Stripe metadata is
    // string-valued, and anything else is not ours.
    expect(snap.metadata).toEqual({ isomux_account: "acct-1" });
  });
});
