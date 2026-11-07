import { describe, expect, test } from "bun:test";
import {
  ENTRY_PLAN,
  POWERUSER_PLAN,
  chargedCurrency,
  planById,
  planByProviderProduct,
  planDisplayForProviderProduct,
  resolveStripePrice,
} from "./plans";

describe("hosted plans", () => {
  test("both tiers map to their provider products", () => {
    expect(planById("office")).toMatchObject({
      label: "Entry",
      providerProduct: "V153",
      customerPrice: { amounts: { USD: 9, EUR: 8 }, billingPeriod: "month" },
    });
    expect(planById("poweruser")).toMatchObject({
      label: "Poweruser",
      providerProduct: "V155",
      customerPrice: { amounts: { USD: 19, EUR: 17 }, billingPeriod: "month" },
    });
    expect(planByProviderProduct("V155")?.id).toBe("poweruser");
  });

  test("an unknown provider product has a total dashboard display", () => {
    expect(planByProviderProduct("outside-catalogue")).toBeNull();
    expect(planDisplayForProviderProduct("outside-catalogue", null)).toEqual({
      label: "Unknown plan",
      specification: null,
      customerPrice: null,
      currency: null,
    });
  });

  // Nil, 2026-11-07: dollars for new customers; a euro subscriber keeps the
  // euro price. The subscription's currency is what we read back.
  test("the display carries the currency the subscription pays in", () => {
    for (const currency of ["USD", "EUR", null] as const) {
      expect([
        currency,
        planDisplayForProviderProduct("V155", currency),
      ]).toEqual([
        currency,
        {
          label: "Poweruser",
          specification: POWERUSER_PLAN.specification,
          customerPrice: {
            amounts: { USD: 19, EUR: 17 },
            billingPeriod: "month",
          },
          currency,
        },
      ]);
    }
  });

  test("a stored Stripe currency maps to a price currency, and no code means euros", () => {
    expect(chargedCurrency("usd")).toBe("USD");
    expect(chargedCurrency("eur")).toBe("EUR");
    // Every subscription reconciled before the column existed paid in euros.
    expect(chargedCurrency(null)).toBe("EUR");
    // A currency we do not sell in has no price to show, not a wrong one.
    expect(chargedCurrency("gbp")).toBeNull();
  });

  test("explicit Entry pricing wins and the legacy price never sells Poweruser", () => {
    expect(
      resolveStripePrice(ENTRY_PLAN, {
        entryStripePriceId: "price-entry",
        legacyEntryStripePriceId: "price-legacy",
      }),
    ).toEqual({ ok: true, stripePriceId: "price-entry" });
    expect(
      resolveStripePrice(ENTRY_PLAN, {
        legacyEntryStripePriceId: "price-legacy",
      }),
    ).toEqual({ ok: true, stripePriceId: "price-legacy" });
    expect(
      resolveStripePrice(POWERUSER_PLAN, {
        legacyEntryStripePriceId: "price-legacy",
      }),
    ).toEqual({
      ok: false,
      reason:
        "This deployment has no Stripe price configured for the Poweruser plan",
    });
  });

  test("display price is independent from the Stripe price id", () => {
    expect(
      resolveStripePrice(
        { ...ENTRY_PLAN, customerPrice: null },
        { entryStripePriceId: "price-entry" },
      ),
    ).toEqual({ ok: true, stripePriceId: "price-entry" });
    expect(
      resolveStripePrice(
        {
          ...POWERUSER_PLAN,
          customerPrice: {
            amounts: { USD: 123, EUR: 123 },
            billingPeriod: "month",
          },
        },
        {},
      ),
    ).toEqual({
      ok: false,
      reason:
        "This deployment has no Stripe price configured for the Poweruser plan",
    });
  });
});
