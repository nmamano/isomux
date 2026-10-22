// Email sign-in links and email change links: the token a link carries, and
// its single use.
//
// A token is `<payload>.<signature>`, both base64url: the payload is JSON
// {e: address, x: expiry, n: nonce} (a change link adds a: account id), the
// signature an HMAC-SHA256 over the payload text. The HMAC key is derived from
// AUTH_SECRET and the link's kind rather than being AUTH_SECRET itself, so a
// token and a session JWT never share a key, and a sign-in link never verifies
// as a change link or the reverse.
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
const EMAIL_CHANGE_CONTEXT = "isomux email change link v1";

export type RedeemResult =
  | { ok: true; email: string }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "used" };

export interface SignInTokens {
  create: (email: string, now?: number) => string;
  redeem: (token: string, now?: number) => RedeemResult;
}

export type LinkCheck<Claims> =
  | { ok: true; claims: Claims; nonce: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "used" };

/**
 * A signed, expiring, single-use link token that carries `Claims`. The key is
 * derived from the secret and `context`, so a token minted for one context
 * never verifies in another.
 *
 * `check` verifies and does not spend; `redeem` verifies and spends.
 */
export interface LinkTokens<Claims> {
  create: (claims: Claims, now?: number) => string;
  check: (token: string, now?: number) => LinkCheck<Claims>;
  redeem: (token: string, now?: number) => LinkCheck<Claims>;
}

export function createLinkTokens<Claims>({
  secret,
  context,
  parse,
  maxUsed = DEFAULT_MAX_USED,
  ttlMs = SIGNIN_LINK_TTL_MS,
}: {
  secret: string;
  context: string;
  /** The claims out of a payload, or null when they are not valid. The keys
   * `x` and `n` are the token's own. */
  parse: (raw: Record<string, unknown>) => Claims | null;
  ttlMs?: number;
  maxUsed?: number;
}): LinkTokens<Claims> {
  const key = createHmac("sha256", secret).update(context).digest();
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

  function check(token: string, now: number): LinkCheck<Claims> {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, reason: "malformed" };
    }
    const [payload, signature] = parts;
    const expected = sign(payload);
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: "bad-signature" };
    }
    const raw = parsePayload(payload);
    const claims = raw && parse(raw);
    if (!raw || !claims) return { ok: false, reason: "malformed" };
    const { x, n } = raw as { x: number; n: string };
    if (now > x) return { ok: false, reason: "expired" };
    if (used.has(n)) return { ok: false, reason: "used" };
    return { ok: true, claims, nonce: n, expiresAt: x };
  }

  return {
    create(claims, now = Date.now()) {
      const payload = Buffer.from(
        JSON.stringify({
          ...claims,
          x: now + ttlMs,
          n: randomBytes(16).toString("base64url"),
        }),
      ).toString("base64url");
      return `${payload}.${sign(payload).toString("base64url")}`;
    },

    check(token, now = Date.now()) {
      return check(token, now);
    },

    redeem(token, now = Date.now()) {
      const checked = check(token, now);
      if (!checked.ok) return checked;
      if (!roomFor(now)) return { ok: false, reason: "used" };
      used.set(checked.nonce, checked.expiresAt);
      return checked;
    },
  };
}

/** The payload's JSON object with its own two keys valid, or null. */
function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (typeof raw !== "object" || raw === null) return null;
    const { x, n } = raw as Record<string, unknown>;
    if (typeof x !== "number") return null;
    if (typeof n !== "string" || !n) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createSignInTokens({
  secret,
  maxUsed,
  ttlMs,
}: {
  secret: string;
  maxUsed?: number;
  ttlMs?: number;
}): SignInTokens {
  const links = createLinkTokens<{ e: string }>({
    secret,
    context: KEY_CONTEXT,
    parse: ({ e }) => (typeof e === "string" ? { e } : null),
    maxUsed,
    ttlMs,
  });
  return {
    create: (email, now) => links.create({ e: email }, now),
    redeem(token, now) {
      const redeemed = links.redeem(token, now);
      if (!redeemed.ok) return redeemed;
      return { ok: true, email: redeemed.claims.e };
    },
  };
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

// ------------------------------------------------------- email change links

/** An email change link: the account it changes and the address it moves to. */
export interface EmailChangeClaims {
  a: string;
  e: string;
}

export function createEmailChangeTokens({
  secret,
  maxUsed,
  ttlMs,
}: {
  secret: string;
  ttlMs?: number;
  maxUsed?: number;
}): LinkTokens<EmailChangeClaims> {
  return createLinkTokens<EmailChangeClaims>({
    secret,
    context: EMAIL_CHANGE_CONTEXT,
    parse: ({ a, e }) =>
      typeof a === "string" && a && typeof e === "string" && e
        ? { a, e }
        : null,
    maxUsed,
    ttlMs,
  });
}

let sharedChange: {
  secret: string;
  tokens: LinkTokens<EmailChangeClaims>;
} | null = null;

/** The deployment's email change tokens, keyed on AUTH_SECRET like the sign-in
 * tokens, under their own context. Null when no AUTH_SECRET is set. */
export function deploymentEmailChangeTokens(): LinkTokens<EmailChangeClaims> | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  if (sharedChange?.secret !== secret) {
    sharedChange = { secret, tokens: createEmailChangeTokens({ secret }) };
  }
  return sharedChange.tokens;
}
