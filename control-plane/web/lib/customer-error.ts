import type { SupportedLanguageCode } from "./i18n/languages";
import { translatorFor, type PlainMessageKey } from "./i18n/translate";
import { inspect } from "node:util";
import { redactLogText } from "../../report";
import { SUPPORT_EMAIL } from "./support-email";

export type CustomerFailureKind = "configuration" | "transient";

export type CustomerFailureSurface =
  | "checkout_reserved"
  | "payments"
  | "reinstatement"
  | "billing_change"
  | "billing_change_ambiguous";

const REFERENCE_PREFIX = "PAY-";

export interface CustomerFailureDependencies {
  newReference?: () => string;
  log?: (message: string, detail: unknown) => void;
}

function referenceCode(): string {
  return `${REFERENCE_PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

/**
 * The sentence for a failure, by kind and surface.
 *
 * These are customer copy - what a paying customer reads when a payment fails -
 * so they are translated by the request's language (S11). THE REFERENCE CODE IS
 * NOT: it is the handle a customer pastes to support and support greps for, and
 * it stays byte-identical in every language.
 */
function friendlySentence(
  language: SupportedLanguageCode,
  kind: CustomerFailureKind,
  surface: CustomerFailureSurface,
): string {
  const { t } = translatorFor(language);
  // A configuration failure is ours, so it names where to write.
  if (kind === "configuration") {
    return t(
      surface === "checkout_reserved"
        ? "errors.checkoutReservedConfiguration"
        : "errors.paymentsConfiguration",
      { support: SUPPORT_EMAIL },
    );
  }
  return t(transientKey(surface));
}

function transientKey(surface: CustomerFailureSurface): PlainMessageKey {
  switch (surface) {
    case "checkout_reserved":
      return "errors.checkoutReservedTransient";
    case "reinstatement":
      return "errors.reinstatementTransient";
    case "billing_change_ambiguous":
      return "errors.billingChangeAmbiguous";
    case "billing_change":
      return "errors.providerTransient";
    case "payments":
      return "errors.providerTransient";
  }
}

/**
 * The default customer boundary is opaque. Callers may return a domain refusal
 * directly only at the explicit branches where our own code produced it.
 */
export function customerFailure(
  language: SupportedLanguageCode,
  kind: CustomerFailureKind,
  surface: CustomerFailureSurface,
  detail: unknown,
  deps: CustomerFailureDependencies = {},
): string {
  const reference = deps.newReference?.() ?? referenceCode();
  const log = deps.log ?? console.error;
  log(
    `[customer-error ${reference}]`,
    redactLogText(
      typeof detail === "string" ? detail : inspect(detail, { depth: 4 }),
    ),
  );
  const { t } = translatorFor(language);
  return `${friendlySentence(language, kind, surface)} ${t("errors.reference", { reference })}`;
}

/**
 * Make an explicitly safe refusal a complete, capitalized sentence.
 *
 * THE REFUSAL ITSELF IS NOT TRANSLATED HERE. A refusal from the control plane's
 * tables (cancel.ts, reinstatement.ts) goes out with its code beside it, and the
 * office page words the code in the reader's language (refusalText in
 * components/office-view.tsx), so this sentence is only its fallback. A refusal
 * with no code (a rejected office name, a coupon the provider would not verify)
 * is English prose with no id to key on, and reads as this. The wrapper's own
 * punctuation is what this adds, and it is the same in every language.
 * `language` is here for the one branch that produces copy of our own: an empty
 * refusal, which becomes an opaque failure sentence.
 */
export function safeCustomerReason(
  language: SupportedLanguageCode,
  reason: string,
  deps: CustomerFailureDependencies = {},
): string {
  const trimmed = reason.trim();
  if (!trimmed)
    return customerFailure(
      language,
      "configuration",
      "payments",
      "An explicitly safe customer refusal was empty",
      deps,
    );
  const capitalized = /^[a-z]/.test(trimmed)
    ? trimmed[0].toUpperCase() + trimmed.slice(1)
    : /^[A-Z]/.test(trimmed)
      ? trimmed
      : `Request refused: ${trimmed}`;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
