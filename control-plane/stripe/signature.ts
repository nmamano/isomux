// Webhook signature verification.
//
// The signed material is `${timestamp}.${rawBody}` - the RAW bytes, before any
// JSON parse. A handler that re-serialised the parsed object would compute a
// signature over different bytes and reject every genuine delivery, so the raw
// body travels all the way from the HTTP layer to here.
//
// Three properties are load-bearing and each is mutation-checked:
//
//   - the join is `t.payload`, not the payload alone;
//   - the timestamp window is rejected in BOTH directions. Too old is replay;
//     too far in the future is a clock or forgery signal, and accepting it would
//     let a captured delivery be replayed indefinitely by dating it forward;
//   - candidates are compared with a constant-time compare, and a candidate of
//     the wrong length is rejected outright rather than short-circuited on
//     content.
//
// Neither the signing secret nor the header ever reaches a message, a log or an
// error: a rejection says WHICH rule failed and nothing about the material.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Stripe's own default, and the value their libraries use. */
export const SIGNATURE_TOLERANCE_SEC = 300;

export type SignatureVerdict =
  | { ok: true; timestamp: number }
  | {
      ok: false;
      failure: "malformed" | "no_match" | "too_old" | "too_new";
      detail: string;
    };

export interface VerifyArgs {
  /** The raw request body, exactly as received. */
  payload: string;
  /** The `Stripe-Signature` header value. */
  header: string | null | undefined;
  secret: string;
  /** Injected, so the window is testable without waiting or faking a system
   * clock. Milliseconds since the epoch. */
  now: number;
  toleranceSec?: number;
}

export function verifySignature(args: VerifyArgs): SignatureVerdict {
  const parsed = parseHeader(args.header);
  if (!parsed) {
    return {
      ok: false,
      failure: "malformed",
      detail:
        "the Stripe-Signature header is missing or has no t= and v1= parts",
    };
  }
  const tolerance = args.toleranceSec ?? SIGNATURE_TOLERANCE_SEC;
  const ageSec = Math.floor(args.now / 1000) - parsed.timestamp;
  if (ageSec > tolerance) {
    return {
      ok: false,
      failure: "too_old",
      detail: `the signed timestamp is ${ageSec}s old, outside the ${tolerance}s window`,
    };
  }
  if (-ageSec > tolerance) {
    // A delivery dated into the future is either a clock problem or an attempt
    // to give a captured payload an indefinite replay window.
    return {
      ok: false,
      failure: "too_new",
      detail: `the signed timestamp is ${-ageSec}s in the future, outside the ${tolerance}s window`,
    };
  }

  const expected = createHmac("sha256", args.secret)
    .update(`${parsed.timestamp}.${args.payload}`, "utf8")
    .digest("hex");
  // EVERY candidate is examined; Stripe sends more than one v1 while a secret is
  // being rotated. No early exit on a match, so the work does not depend on
  // which candidate matched.
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (constantTimeEquals(candidate, expected)) matched = true;
  }
  if (!matched) {
    return {
      ok: false,
      failure: "no_match",
      detail: `no v1 signature of the ${parsed.signatures.length} offered matches`,
    };
  }
  return { ok: true, timestamp: parsed.timestamp };
}

function parseHeader(
  header: string | null | undefined,
): { timestamp: number; signatures: string[] } | null {
  if (!header) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      // Deliberately strict: a non-integer timestamp is malformed, not zero.
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Constant-time compare of two hex digests.
 *
 * A length mismatch is rejected without a content compare, because
 * `timingSafeEqual` throws on unequal lengths - and the length of a hex digest
 * is public anyway, so nothing is leaked by refusing early.
 */
function constantTimeEquals(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false;
  if (!/^[0-9a-f]+$/i.test(candidate)) return false;
  return timingSafeEqual(
    Buffer.from(candidate.toLowerCase(), "utf8"),
    Buffer.from(expected, "utf8"),
  );
}
