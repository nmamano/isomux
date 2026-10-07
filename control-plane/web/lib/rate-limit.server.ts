// Per-IP limits on the storefront's abuse-prone routes: sign-in (start and
// callback share one quota) and checkout start (POST /api/signup).
//
// THE KEY IS THE X-Forwarded-For VALUE, WHOLE. The reverse proxy in front
// (control-plane/deploy/vps/hosted.caddy.example) replaces that header with the
// client address it resolved itself, and the storefront port is reachable only
// through it. That is the security boundary: keying on the whole string does not
// repair a proxy that passes a client-sent header through, and neither would
// picking one entry of a list. A missing or blank header shares one bucket
// rather than bypassing the limit.
//
// The counters live in this process's memory. The storefront runs as one
// process, so a restart or a redeploy starts every window afresh; for a limit
// whose job is to stop floods and scripted sign-in or checkout loops, that is
// acceptable. Expiry is lazy: there is no timer.

import { translatorFor } from "./i18n/translate";
import { RATE_LIMITED_SIGNIN_URL } from "./rate-limit-marker";
import {
  LANGUAGE_COOKIE,
  languageFromAcceptLanguage,
  languageFromCookie,
  type SupportedLanguageCode,
} from "./i18n/languages";

export interface LimiterOptions {
  /** Requests allowed per key within one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Most keys tracked at once. */
  maxKeys: number;
}

export type LimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface Limiter {
  take: (key: string, now?: number) => LimitDecision;
}

/**
 * A fixed window per key. A window starts at a key's first request and covers
 * `windowMs`; a request at exactly `windowStart + windowMs` opens a new one.
 *
 * Bounded: at `maxKeys`, expired entries go first, and if every entry is still
 * live the oldest-inserted ones go. A flood of distinct addresses can therefore
 * forgive some earlier callers, but never grow the map.
 */
export function createLimiter({
  limit,
  windowMs,
  maxKeys,
}: LimiterOptions): Limiter {
  // Insertion order is what makes oldest-first eviction cheap.
  const windows = new Map<string, { count: number; start: number }>();

  return {
    take(key, now = Date.now()) {
      const current = windows.get(key);
      if (current && now - current.start < windowMs) {
        if (current.count >= limit) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((current.start + windowMs - now) / 1000),
            ),
          };
        }
        current.count += 1;
        return { allowed: true };
      }
      windows.delete(key);
      if (windows.size >= maxKeys) {
        for (const [stale, entry] of windows) {
          if (now - entry.start >= windowMs) windows.delete(stale);
        }
        while (windows.size >= maxKeys) {
          const oldest = windows.keys().next();
          if (oldest.done) break;
          windows.delete(oldest.value);
        }
      }
      windows.set(key, { count: 1, start: now });
      return { allowed: true };
    },
  };
}

const TEN_MINUTES = 10 * 60 * 1000;
const MAX_KEYS = 10_000;

/** Sign-in start and callback together: one sign-in costs two requests. */
export const authLimiter = createLimiter({
  limit: 40,
  windowMs: TEN_MINUTES,
  maxKeys: MAX_KEYS,
});

/** POST /api/signup, which opens a Stripe Checkout session. */
export const signupLimiter = createLimiter({
  limit: 10,
  windowMs: TEN_MINUTES,
  maxKeys: MAX_KEYS,
});

export const UNKNOWN_CLIENT = "unknown";

export function clientKey(headers: Headers): string {
  const address = headers.get("x-forwarded-for")?.trim() ?? "";
  return address.length > 0 ? address : UNKNOWN_CLIENT;
}

// The same precedence as languageForRequest (cookie, then Accept-Language),
// read from the request itself so this file needs no request scope.
function languageOf(headers: Headers): SupportedLanguageCode {
  const cookie = headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === LANGUAGE_COOKIE) {
      const chosen = languageFromCookie(value.join("="));
      if (chosen) return chosen;
    }
  }
  return languageFromAcceptLanguage(headers.get("accept-language"));
}

/**
 * The 429. A sign-in start comes from next-auth's client `signIn()`, which
 * reads the body as JSON and navigates to its `url` without looking at the
 * status (it marks itself with X-Auth-Return-Redirect): that request gets the
 * fixed sign-in URL, where the page shows the sentence. Every other request gets
 * the sentence as text, which the signup form shows as delivered.
 */
export function tooManyRequests(
  request: Request,
  retryAfterSeconds: number,
): Response {
  const headers = { "retry-after": String(retryAfterSeconds) };
  if (request.headers.has("x-auth-return-redirect")) {
    return Response.json(
      { url: RATE_LIMITED_SIGNIN_URL },
      { status: 429, headers },
    );
  }
  const { t } = translatorFor(languageOf(request.headers));
  return new Response(t("errors.rateLimited"), {
    status: 429,
    headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
  });
}

/** A refusal for this request, or null when it may go on. */
export function limitRequest(
  limiter: Limiter,
  request: Request,
  now?: number,
): Response | null {
  const decision = limiter.take(clientKey(request.headers), now);
  return decision.allowed
    ? null
    : tooManyRequests(request, decision.retryAfterSeconds);
}

const COUNTED_AUTH_ACTIONS = ["signin", "callback"];

/** True for /api/auth/signin/<provider> and /api/auth/callback/<provider>.
 * csrf, session, providers and the rest do not count. */
export function isCountedAuthPath(pathname: string): boolean {
  const [api, auth, action, provider] = pathname.split("/").filter(Boolean);
  return (
    api === "api" &&
    auth === "auth" &&
    COUNTED_AUTH_ACTIONS.includes(action ?? "") &&
    !!provider
  );
}

/** Auth.js's route handler, with the sign-in quota in front of it. */
export function withAuthLimit<Args extends [Request, ...unknown[]]>(
  handler: (...args: Args) => Promise<Response>,
  limiter: Limiter = authLimiter,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    const [request] = args;
    if (isCountedAuthPath(new URL(request.url).pathname)) {
      const refusal = limitRequest(limiter, request);
      if (refusal) return refusal;
    }
    return handler(...args);
  };
}
