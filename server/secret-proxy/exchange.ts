// The token exchange (internal-docs/secrets-design.md, task 124eb47e). A
// secret with `exchange` holds a client or app secret. The proxy trades it,
// with the id, for a short-lived token at the token address, keeps the token
// in memory until shortly before it expires, and sends the token where the
// secret's form says. The agent never holds the id's secret or the token.
//
// buildExchangeRequest and parseExchangeReply are pure, so the server's
// connection test sends and reads the exchange exactly as the proxy does.
// Nothing here logs or returns reply content: a failure is a fixed reason.

import { createHash } from "node:crypto";

import type { ExchangeSpec } from "../../shared/secret-hosts.ts";
import type { ProxySecret } from "./proxy.ts";

export const EXCHANGE_TIMEOUT_MS = 10_000;
// The most bytes read of a token reply.
export const EXCHANGE_REPLY_CAP = 64 * 1024;
// A failed exchange is answered from the cache for this long, with no fetch.
export const EXCHANGE_BACKOFF_MS = 30_000;
// An upstream 401 drops a token only when it is at least this old.
export const EXCHANGE_401_MIN_AGE_MS = 60_000;
// A reply without a lifetime counts as this one; a longer one is cut to the
// ceiling.
export const EXCHANGE_DEFAULT_LIFETIME_MS = 60 * 60 * 1000;
export const EXCHANGE_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

// The one request of an exchange: an HTTP/1.1 POST to the token address.
export interface ExchangeRequest {
  host: string;
  // Path and query of the token address.
  path: string;
  headers: [string, string][];
  body: string;
}

// Why an exchange failed. A number is the token address's status.
export type ExchangeFailure =
  number | "unreachable" | "timeout" | "redirect" | "no_token";

export type ExchangeReply =
  | { ok: true; token: string; lifetimeMs: number }
  | { ok: false; reason: ExchangeFailure };

export function buildExchangeRequest(
  exchange: ExchangeSpec,
  secret: string,
): ExchangeRequest {
  const url = new URL(exchange.url);
  const headers: [string, string][] = [["Accept", "application/json"]];
  let body: string;
  if (exchange.body.kind === "json") {
    // The params first, so the id and secret fields always win (the check
    // refuses params of those names anyway).
    body = JSON.stringify({
      ...exchange.params,
      [exchange.body.idField]: exchange.id,
      [exchange.body.secretField]: secret,
    });
    headers.push(["Content-Type", "application/json; charset=utf-8"]);
  } else {
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (exchange.body.clientAuth === "basic") {
      // RFC 6749 2.3.1: each part is form-encoded before Basic.
      const pair = `${formEncode(exchange.id)}:${formEncode(secret)}`;
      headers.push([
        "Authorization",
        `Basic ${Buffer.from(pair, "utf8").toString("base64")}`,
      ]);
    } else {
      form.set("client_id", exchange.id);
      form.set("client_secret", secret);
    }
    for (const [key, value] of Object.entries(exchange.params))
      form.set(key, value);
    body = form.toString();
    headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
  }
  return {
    host: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers,
    body,
  };
}

// application/x-www-form-urlencoded for one value.
function formEncode(text: string): string {
  return new URLSearchParams({ v: text }).toString().slice(2);
}

// An own property along a dotted path, or undefined.
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const step of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, step)) return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}

const TOKEN_TEXT = /^[\x21-\x7e]{8,8192}$/;

// The token and its lifetime from a reply, or why there is none. A 3xx is
// "redirect" (never followed: a 307 or 308 would send the secret again); any
// other status but 2xx is that status.
export function parseExchangeReply(
  exchange: ExchangeSpec,
  status: number,
  body: string,
): ExchangeReply {
  if (status >= 300 && status < 400) return { ok: false, reason: "redirect" };
  if (status < 200 || status >= 300) return { ok: false, reason: status };
  const none = { ok: false as const, reason: "no_token" as const };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return none;
  }
  const token = at(parsed, exchange.tokenField);
  if (typeof token !== "string" || !TOKEN_TEXT.test(token)) return none;
  const expiry = at(parsed, exchange.expiryField);
  let lifetimeMs = EXCHANGE_DEFAULT_LIFETIME_MS;
  if (expiry !== undefined) {
    const seconds =
      typeof expiry === "number"
        ? expiry
        : typeof expiry === "string" && /^[0-9]+(\.[0-9]+)?$/.test(expiry)
          ? Number(expiry)
          : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return none;
    lifetimeMs = Math.min(seconds * 1000, EXCHANGE_MAX_LIFETIME_MS);
  }
  return { ok: true, token, lifetimeMs };
}

// How long before the end of its lifetime a token is fetched again.
export function refreshMarginMs(lifetimeMs: number): number {
  return Math.min(Math.max(60_000, lifetimeMs / 10), lifetimeMs / 2);
}

const FAILURE_TEXT: Record<Exclude<ExchangeFailure, number>, string> = {
  unreachable: "the token address could not be reached",
  timeout: "the token address did not answer in time",
  redirect: "the token address answered with a redirect, which is not followed",
  no_token: "the reply had no usable token",
};

// The text the agent reads in the proxy's 502 for a failed exchange.
export function exchangeFailureText(
  name: string,
  reason: ExchangeFailure,
): string {
  const why =
    typeof reason === "number"
      ? `the token address answered ${reason}`
      : FAILURE_TEXT[reason];
  return `the token exchange for secret ${name} failed: ${why}`;
}

// A failure of the send, as a fixed reason. Its message is the reason only.
export class ExchangeError extends Error {
  constructor(readonly reason: "unreachable" | "timeout") {
    super(reason);
  }
}

// Sends one exchange request and reads the reply: status and body (at most
// EXCHANGE_REPLY_CAP bytes), or a thrown ExchangeError (or its reason as a
// string).
export type ExchangeSend = (
  request: ExchangeRequest,
) => Promise<{ status: number; body: string }>;

export interface TokenCacheDeps {
  send: ExchangeSend;
  now: () => number;
  // One call per exchange sent, for the use row.
  onExchange?: (secret: ProxySecret, request: ExchangeRequest) => void;
}

export interface TokenCache {
  // The secret's token: cached while it is fresh, else fetched, with one
  // fetch in flight per secret. A failure is kept for EXCHANGE_BACKOFF_MS.
  token(secret: ProxySecret): Promise<ExchangeReply>;
  // An upstream 401 on a request that carried `token`.
  unauthorized(secret: ProxySecret, token: string): void;
  // The tokens the service may still take, for the scrub: the held ones,
  // and the replaced or dropped ones until they expire.
  liveTokens(): string[];
  // Goes up at each change of the live tokens.
  version(): number;
}

interface Entry {
  // The token and when it came, or the failure and when it came.
  reply: ExchangeReply;
  at: number;
  // When the token is fetched again (a token), or when the failure ends.
  until: number;
  // When the token expires; 0 for a failure.
  expires: number;
}

const FAILURES = new Set<string>(["unreachable", "timeout", "redirect"]);

function cacheKey(secret: ProxySecret): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        secret.scope,
        secret.name,
        secret.value,
        secret.exchange,
      ]),
    )
    .digest("hex");
}

export function createTokenCache(deps: TokenCacheDeps): TokenCache {
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<ExchangeReply>>();
  // Tokens that a refresh replaced or a 401 dropped, until they expire: a
  // request that carried one can still be in flight, and the service still
  // takes it, so the scrub keeps it. Token -> expiry.
  const retired = new Map<string, number>();
  let version = 0;

  function set(key: string, entry: Entry | null): void {
    const before = entries.get(key);
    const beforeToken = before?.reply.ok ? before.reply.token : null;
    if (entry) entries.set(key, entry);
    else entries.delete(key);
    const afterToken = entry?.reply.ok ? entry.reply.token : null;
    if (beforeToken === afterToken) return;
    if (before && beforeToken !== null && before.expires > deps.now())
      retired.set(beforeToken, before.expires);
    version++;
  }

  async function fetchToken(
    key: string,
    secret: ProxySecret,
  ): Promise<ExchangeReply> {
    const exchange = secret.exchange as ExchangeSpec;
    const request = buildExchangeRequest(exchange, secret.value);
    deps.onExchange?.(secret, request);
    let reply: ExchangeReply;
    try {
      const answer = await deps.send(request);
      reply = parseExchangeReply(exchange, answer.status, answer.body);
    } catch (error) {
      reply = {
        ok: false,
        reason:
          error instanceof ExchangeError
            ? error.reason
            : typeof error === "string" && FAILURES.has(error)
              ? (error as ExchangeFailure)
              : "unreachable",
      };
    }
    const now = deps.now();
    if (reply.ok) {
      set(key, {
        reply,
        at: now,
        until: now + reply.lifetimeMs - refreshMarginMs(reply.lifetimeMs),
        expires: now + reply.lifetimeMs,
      });
      return reply;
    }
    // A refresh that fails while the old token is still valid keeps it;
    // the next fetch waits out the backoff.
    const held = entries.get(key);
    if (held?.reply.ok && held.expires > now) {
      held.until = Math.min(held.expires, now + EXCHANGE_BACKOFF_MS);
      return held.reply;
    }
    set(key, { reply, at: now, until: now + EXCHANGE_BACKOFF_MS, expires: 0 });
    return reply;
  }

  // Drops expired tokens and ended failures, so a rotated value's old token
  // does not stay in memory or in the scrub set.
  function sweep(now: number): void {
    for (const [key, entry] of entries)
      if ((entry.reply.ok ? entry.expires : entry.until) <= now) set(key, null);
    for (const [token, expires] of retired)
      if (expires <= now) {
        retired.delete(token);
        version++;
      }
  }

  return {
    token(secret) {
      if (!secret.exchange)
        return Promise.resolve({ ok: false, reason: "no_token" });
      sweep(deps.now());
      const key = cacheKey(secret);
      const entry = entries.get(key);
      if (entry && deps.now() < entry.until)
        return Promise.resolve(entry.reply);
      const running = inFlight.get(key);
      if (running) return running;
      const fetched = fetchToken(key, secret).finally(() =>
        inFlight.delete(key),
      );
      inFlight.set(key, fetched);
      return fetched;
    },

    unauthorized(secret, token) {
      if (!secret.exchange) return;
      const key = cacheKey(secret);
      const entry = entries.get(key);
      if (!entry?.reply.ok || entry.reply.token !== token) return;
      if (deps.now() - entry.at < EXCHANGE_401_MIN_AGE_MS) return;
      set(key, null);
    },

    liveTokens() {
      const now = deps.now();
      const tokens = new Set<string>();
      for (const entry of entries.values())
        if (entry.reply.ok) tokens.add(entry.reply.token);
      for (const [token, expires] of retired)
        if (expires > now) tokens.add(token);
      return [...tokens];
    },

    version: () => version,
  };
}
