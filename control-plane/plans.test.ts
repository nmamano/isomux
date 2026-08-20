import { describe, expect, test } from "bun:test";
import {
  ENTRY_PLAN,
  POWERUSER_PLAN,
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
      customerPrice: { amount: 8, currency: "EUR", billingPeriod: "month" },
    });
    expect(planById("poweruser")).toMatchObject({
      label: "Poweruser",
      providerProduct: "V155",
      customerPrice: { amount: 17, currency: "EUR", billingPeriod: "month" },
    });
    expect(planByProviderProduct("V155")?.id).toBe("poweruser");
  });

  test("an unknown provider product has a total dashboard display", () => {
    expect(planByProviderProduct("outside-catalogue")).toBeNull();
    expect(planDisplayForProviderProduct("outside-catalogue")).toEqual({
      label: "Unknown plan",
      specification: null,
      customerPrice: null,
    });
  });

  test("explicit Entry pricing wins and the legacy price never sells Poweruser", () => {
    expect(
      resolveStripePrice(ENTRY_PLAN, {
        entryStripePriceId: "price-entry",
        legacyEntryStripePriceId: "price-legacy",
      }),
    ).toEqual({ ok: true, stripePriceId: "price-entry" });
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
            amount: 123,
            currency: "EUR",
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
