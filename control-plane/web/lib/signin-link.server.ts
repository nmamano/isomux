// Email sign-in links: the token a link carries, and its single use.
//
// A token is `<payload>.<signature>`, both base64url: the payload is JSON
// {e: address, x: expiry, n: nonce}, the signature an HMAC-SHA256 over the
// payload text. The HMAC key is derived from AUTH_SECRET rather than being
// AUTH_SECRET itself, so a token and a session JWT never share a key.
//
// THERE IS NO TABLE. The storefront runs as one process (rate-limit.server.ts
// rests on the same premise), so the record of used links lives in its memory.
// A restart forgets it: a link already used and not yet expired then works once
// more within its 15 minutes, and only for whoever holds the inbox's mail.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SIGNIN_LINK_TTL_MS } from "./signin-link-payload";

export { SIGNIN_LINK_TTL_MS };

/** Links are minted only past both request limiters, so this bound is far above
 * what fits in one TTL. */
const DEFAULT_MAX_USED = 100_000;

const KEY_CONTEXT = "isomux email sign-in link v1";

export type RedeemResult =
  | { ok: true; email: string }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "used" };

export interface SignInTokens {
  create: (email: string, now?: number) => string;
  redeem: (token: string, now?: number) => RedeemResult;
}

export function createSignInTokens({
  secret,
  maxUsed = DEFAULT_MAX_USED,
  ttlMs = SIGNIN_LINK_TTL_MS,
}: {
  secret: string;
  maxUsed?: number;
  ttlMs?: number;
}): SignInTokens {
  const key = createHmac("sha256", secret).update(KEY_CONTEXT).digest();
  const sign = (payload: string) =>
    createHmac("sha256", key).update(payload).digest();
  // nonce -> the expiry of the token that spent it.
  const used = new Map<string, number>();

  // FAIL CLOSED. A used nonce may leave the record only once its token has
  // expired, because a live one that left could be redeemed again. When every
  // entry is still live the record is full and redemption is refused.
  function roomFor(now: number): boolean {
    if (used.size < maxUsed) return true;
    for (const [nonce, expiry] of used) {
      if (expiry < now) used.delete(nonce);
    }
    return used.size < maxUsed;
  }

  return {
    create(email, now = Date.now()) {
      const payload = Buffer.from(
        JSON.stringify({
          e: email,
          x: now + ttlMs,
          n: randomBytes(16).toString("base64url"),
        }),
      ).toString("base64url");
      return `${payload}.${sign(payload).toString("base64url")}`;
    },

    redeem(token, now = Date.now()) {
      const parts = token.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return { ok: false, reason: "malformed" };
      }
      const [payload, signature] = parts;
      const expected = sign(payload);
      const given = Buffer.from(signature, "base64url");
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        return { ok: false, reason: "bad-signature" };
      }
      const claims = parseClaims(payload);
      if (!claims) return { ok: false, reason: "malformed" };
      if (now > claims.x) return { ok: false, reason: "expired" };
      if (used.has(claims.n)) return { ok: false, reason: "used" };
      if (!roomFor(now)) return { ok: false, reason: "used" };
      used.set(claims.n, claims.x);
      return { ok: true, email: claims.e };
    },
  };
}

function parseClaims(
  payload: string,
): { e: string; x: number; n: string } | null {
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (typeof claims !== "object" || claims === null) return null;
    const { e, x, n } = claims as Record<string, unknown>;
    if (typeof e !== "string" || typeof x !== "number") return null;
    if (typeof n !== "string" || !n) return null;
    return { e, x, n };
  } catch {
    return null;
  }
}

const MAX_ADDRESS_LENGTH = 254;

/** Trimmed and lowercased, or null when it is not one plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_ADDRESS_LENGTH) return null;
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

let shared: { secret: string; tokens: SignInTokens } | null = null;

/** The deployment's tokens, keyed on AUTH_SECRET: the request route mints with
 * them and the Auth.js provider redeems with them, so the used-link record is
 * the one this process keeps. Null when no AUTH_SECRET is set. */
export function deploymentSignInTokens(): SignInTokens | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  if (shared?.secret !== secret) {
    shared = { secret, tokens: createSignInTokens({ secret }) };
  }
  return shared.tokens;
}
