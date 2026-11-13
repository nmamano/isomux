export type PriceCurrency = "USD" | "EUR";

/**
 * Customer-visible recurring price copy. USD is the price we sell at; EUR is
 * the price that subscriptions made on the old euro Prices keep paying.
 * Stripe price ids are separate: one USD-only Price per plan.
 */
export interface CustomerPrice {
  amounts: Record<PriceCurrency, number>;
  billingPeriod: "month";
}

export interface Plan {
  id: string;
  label: string;
  providerProduct: string;
  region: string;
  specification: string;
  customerPrice: CustomerPrice | null;
}

// Nil decides every customer-visible specification and price in this block.
//
// The amounts also identify a subscription's plan (planForItemPrice, read by
// plan-price-check.ts). A price change for new customers must keep the old
// amount as a legacy amount, or every older subscription is reported as on the
// wrong plan after the grace period.
export const ENTRY_PLAN: Plan = {
  id: "office",
  label: "Entry",
  providerProduct: "V153",
  region: "EU",
  specification: "4 vCPU, 8 GB RAM, 100 GB SSD",
  // Nil, 2026-08-20: supplier cost times 1.4, rounded up to the next whole unit.
  // EUR 5.50 x 1.4 = 7.70 -> EUR 8; at EUR/USD 1.115 (2026-11-06) -> USD 9
  // (Nil, 2026-11-06). Dollars only for new customers (Nil, 2026-11-07).
  customerPrice: { amounts: { USD: 9, EUR: 8 }, billingPeriod: "month" },
};

// V155 source: Contabo account read, 2026-08-20.
export const POWERUSER_PLAN: Plan = {
  id: "poweruser",
  label: "Poweruser",
  providerProduct: "V155",
  region: "EU",
  specification: "8 vCPU, 24 GB RAM, 300 GB SSD",
  // Same formula; EUR 11.5 and 11.90 supplier readings both round up to
  // EUR 17, and to USD 19 at EUR/USD 1.115.
  customerPrice: { amounts: { USD: 19, EUR: 17 }, billingPeriod: "month" },
};

export const PLANS: Plan[] = [ENTRY_PLAN, POWERUSER_PLAN];

export function planById(id: string): Plan | null {
  return PLANS.find((plan) => plan.id === id) ?? null;
}

export function planByProviderProduct(product: string): Plan | null {
  return PLANS.find((plan) => plan.providerProduct === product) ?? null;
}

/**
 * The plan a subscription item's price pays for: the plan whose customerPrice
 * amount in the price's own currency, in cents, is the price's unit amount.
 * Null for any other price.
 */
export function planForItemPrice(price: {
  unitAmount: number;
  currency: string;
}): Plan | null {
  const currency = price.currency.toUpperCase();
  if (currency !== "USD" && currency !== "EUR") return null;
  return (
    PLANS.find(
      (plan) =>
        plan.customerPrice !== null &&
        plan.customerPrice.amounts[currency] * 100 === price.unitAmount,
    ) ?? null
  );
}

/**
 * The currency a subscription pays in, from subscriptions.currency (Stripe's
 * lower-case code). Null is a row reconciled before the column existed, and
 * every such subscription paid in euros. No new subscription is in euros: the
 * Prices are USD-only, and Adaptive Pricing keeps the subscription in USD.
 * Any other code is null: no price.
 */
export function chargedCurrency(stored: string | null): PriceCurrency | null {
  if (stored === null) return "EUR";
  if (stored === "usd") return "USD";
  if (stored === "eur") return "EUR";
  return null;
}

export interface PlanDisplay {
  label: string;
  specification: string | null;
  customerPrice: CustomerPrice | null;
  /** What the customer pays in; null before Checkout is done. */
  currency: PriceCurrency | null;
}

export function planDisplayForProviderProduct(
  product: string,
  currency: PriceCurrency | null,
): PlanDisplay {
  const plan = planByProviderProduct(product);
  return plan
    ? {
        label: plan.label,
        specification: plan.specification,
        customerPrice: plan.customerPrice,
        currency,
      }
    : {
        label: "Unknown plan",
        specification: null,
        customerPrice: null,
        currency: null,
      };
}

export interface StripePriceConfiguration {
  entryStripePriceId?: string;
  poweruserStripePriceId?: string;
  legacyEntryStripePriceId?: string;
}

export type StripePriceResolution =
  { ok: true; stripePriceId: string } | { ok: false; reason: string };

/** The explicit Entry value wins. The legacy value sells Entry only. */
export function resolveStripePrice(
  plan: Plan,
  configured: StripePriceConfiguration,
): StripePriceResolution {
  const stripePriceId =
    plan.id === ENTRY_PLAN.id
      ? (configured.entryStripePriceId ?? configured.legacyEntryStripePriceId)
      : plan.id === POWERUSER_PLAN.id
        ? configured.poweruserStripePriceId
        : undefined;
  return stripePriceId
    ? { ok: true, stripePriceId }
    : {
        ok: false,
        reason: `This deployment has no Stripe price configured for the ${plan.label} plan`,
      };
}
