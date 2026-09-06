import type { CustomerPrice } from "../../plans";
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

export function customerPriceLine(
  language: SupportedLanguageCode,
  price: CustomerPrice | null,
): string | null {
  if (!price) return null;
  const { t } = translatorFor(language);
  const amount = new Intl.NumberFormat(language, {
    style: "currency",
    currency: price.currency,
  }).format(price.amount);
  const period = keyFrom(PERIOD_KEYS, price.billingPeriod);
  // An unknown period is data we have no word for: show it as it arrived
  // rather than print a key at a customer.
  return t("plan.priceLine", {
    amount,
    period: period ? t(period) : price.billingPeriod,
  });
}
