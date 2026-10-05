// Webhook signature checks. See internal-docs/webhooks-design.md section 1.
//
// Both schemes are an HMAC-SHA256 of the raw body bytes, compared in constant
// time. The header is attacker-controlled, so every malformed shape is a plain
// `false` decided by a guard before any decode: nothing here throws on input
// that came from the request.

import { createHmac, timingSafeEqual } from "crypto";
import type { WebhookScheme } from "../../shared/types.ts";

const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;
// 32 bytes in base64 is 43 characters plus one "=". Standard or url-safe
// alphabet, padding optional. Buffer's base64 decoder skips characters it does
// not know, so the shape is checked here and not left to the decoder.
const BASE64_DIGEST = /^[A-Za-z0-9+/_-]{43}=?$/;

// The decoded 32-byte digest the header claims, or null for any other shape.
function parseDigest(scheme: WebhookScheme, header: string): Buffer | null {
  if (scheme === "github-hmac-sha256") {
    if (!header.startsWith("sha256=")) return null;
    const hex = header.slice("sha256=".length);
    return HEX_DIGEST.test(hex) ? Buffer.from(hex, "hex") : null;
  }
  let value = header.trim();
  if (value.startsWith("sha256=")) value = value.slice("sha256=".length);
  if (HEX_DIGEST.test(value)) return Buffer.from(value, "hex");
  if (BASE64_DIGEST.test(value)) {
    const bytes = Buffer.from(
      value.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    return bytes.length === 32 ? bytes : null;
  }
  return null;
}

export function verifyWebhookSignature(
  scheme: WebhookScheme,
  secret: string,
  body: Uint8Array,
  header: string | null,
): boolean {
  if (header === null) return false;
  const claimed = parseDigest(scheme, header);
  if (claimed === null) return false;
  const actual = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(actual, claimed);
}
