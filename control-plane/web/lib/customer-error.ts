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

function friendlyLine(
  kind: CustomerFailureKind,
  surface: CustomerFailureSurface,
): string {
  if (kind === "configuration") {
    return surface === "checkout_reserved"
      ? "We could not open a payment page. Your name is reserved."
      : "Payments are not available right now.";
  }
  switch (surface) {
    case "checkout_reserved":
      return "We could not open a payment page just now. Your name is reserved, so try again in a moment.";
    case "reinstatement":
      return "We could not open reinstatement payment just now. Try again in a moment.";
    case "billing_change_ambiguous":
      return "We could not confirm your change with our payment provider. Check back in a moment before trying again.";
    case "billing_change":
      return "We could not reach our payment provider just now. Try again in a moment.";
    case "payments":
      return "We could not reach our payment provider just now. Try again in a moment.";
  }
}

/**
 * The default customer boundary is opaque. Callers may return a domain refusal
 * directly only at the explicit branches where our own code produced it.
 */
export function customerFailure(
  kind: CustomerFailureKind,
  surface: CustomerFailureSurface,
  detail: unknown,
  deps: CustomerFailureDependencies = {},
): string {
  const reference = deps.newReference?.() ?? referenceCode();
  const log = deps.log ?? console.error;
  log(`[customer-error ${reference}]`, detail);
  return `${friendlyLine(kind, surface)} Reference: ${reference}.`;
}

/** Make an explicitly safe refusal a complete, capitalized sentence. */
export function safeCustomerReason(
  reason: string,
  deps: CustomerFailureDependencies = {},
): string {
  const trimmed = reason.trim();
  if (!trimmed)
    return customerFailure(
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
