import type { CustomerPrice, PriceCurrency } from "../../plans";
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { keyFrom, translatorFor } from "../lib/i18n/translate";

/**
 * The billing period as a word, keyed by the id the plan carries.
 *
 * The AMOUNT is formatted by Intl in the reader's language, so a Spanish
 * customer reads "8,00 €" rather than "€8.00". English is unchanged: "en" is
 * the locale this call already passed.
 */
const PERIOD_KEYS = { month: "plan.period.month" } as const;

/**
 * One plan's price for a customer: the amount in the currency the
 * subscription pays in, or with no currency (signup, an office whose Checkout
 * is not done, an ended subscription) the dollar list price.
 */
export function customerPriceLine(
  language: SupportedLanguageCode,
  price: CustomerPrice | null,
  currency: PriceCurrency | null,
): string | null {
  if (!price) return null;
  const { t } = translatorFor(language);
  const format = (code: PriceCurrency) =>
    new Intl.NumberFormat(language, {
      style: "currency",
      currency: code,
    }).format(price.amounts[code]);
  const periodKey = keyFrom(PERIOD_KEYS, price.billingPeriod);
  // An unknown period is data we have no word for: show it as it arrived
  // rather than print a key at a customer.
  const period = periodKey ? t(periodKey) : price.billingPeriod;
  return t("plan.priceLine", { amount: format(currency ?? "USD"), period });
}
