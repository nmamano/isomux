import type { CustomerPrice } from "../../plans";

export function customerPriceLine(price: CustomerPrice | null): string | null {
  if (!price) return null;
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency: price.currency,
  }).format(price.amount);
  return `${amount} per ${price.billingPeriod}`;
}
