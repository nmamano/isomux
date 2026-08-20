/** Customer-visible recurring price copy. Stripe price ids are separate. */
export interface CustomerPrice {
  amount: number;
  currency: "EUR" | "USD";
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
export const ENTRY_PLAN: Plan = {
  id: "office",
  label: "Entry",
  providerProduct: "V153",
  region: "EU",
  specification: "4 vCPU, 8 GB memory, 100 GB SSD",
  // Nil, 2026-08-20: supplier cost times 1.4, rounded up to the next euro.
  customerPrice: { amount: 8, currency: "EUR", billingPeriod: "month" },
};

// V155 source: Contabo account read, 2026-08-20.
export const POWERUSER_PLAN: Plan = {
  id: "poweruser",
  label: "Poweruser",
  providerProduct: "V155",
  region: "EU",
  specification: "8 vCPU, 24 GB memory, 300 GB SSD",
  // Same formula; EUR 11.5 and 11.90 supplier readings both round up to 17.
  customerPrice: { amount: 17, currency: "EUR", billingPeriod: "month" },
};

export const PLANS: Plan[] = [ENTRY_PLAN, POWERUSER_PLAN];

export function planById(id: string): Plan | null {
  return PLANS.find((plan) => plan.id === id) ?? null;
}

export function planByProviderProduct(product: string): Plan | null {
  return PLANS.find((plan) => plan.providerProduct === product) ?? null;
}

export interface PlanDisplay {
  label: string;
  specification: string | null;
  customerPrice: CustomerPrice | null;
}

export function planDisplayForProviderProduct(product: string): PlanDisplay {
  const plan = planByProviderProduct(product);
  return plan
    ? {
        label: plan.label,
        specification: plan.specification,
        customerPrice: plan.customerPrice,
      }
    : {
        label: "Unknown plan",
        specification: null,
        customerPrice: null,
      };
}

export interface StripePriceConfiguration {
  entryStripePriceId?: string;
  poweruserStripePriceId?: string;
  legacyEntryStripePriceId?: string;
}

export type StripePriceResolution =
  | { ok: true; stripePriceId: string }
  | { ok: false; reason: string };

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
