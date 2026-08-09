// Stripe REST transport. TEST MODE ONLY, enforced here rather than by convention.
//
// Two things this file exists to do, and it does nothing else:
//
//   1. REFUSE A LIVE KEY. The office's Stripe MCP credentials are live-mode on
//      the real company account; this code path must never be reachable with
//      one. The check is at construction, by prefix, and it throws a named error
//      rather than returning a result - there is no caller for whom "carry on
//      with a live key" is the right behaviour.
//   2. CLASSIFY. Like the Contabo transport, a call returns an outcome class
//      rather than throwing, because "the request was refused" and "we cannot
//      establish what happened" need different handling. Unlike Contabo, Stripe
//      documents an idempotency key, so an ambiguous WRITE can be repeated with
//      the same key and is - that key is the only reason a retry here is not the
//      blind retry the loop's rails forbid.
//
// No `stripe` npm dependency on purpose: this repo is public and self-hosters
// install it, so it does not grow a billing SDK for a control-plane-only need.
// The cost is this file plus signature.ts, both small and both mutation-checked.

export const STRIPE_API_BASE = "https://api.stripe.com";

/**
 * Pinned deliberately.
 *
 * Observed 2026-08-09: this is the test account's own default version, read from
 * the `stripe-version` response header. It is pinned rather than left to the
 * account default because the behaviours this slice verifies - Checkout's
 * `payment_method_collection: if_required` on a fully discounted subscription,
 * and what a coupon lapse does to subscription status - are version-dependent.
 * An unpinned client would let Stripe change them under us silently, which is
 * exactly the failure the dated observations in the design doc exist to prevent.
 */
export const STRIPE_API_VERSION = "2026-07-29.dahlia";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 3;

/** A live-mode credential reached test-mode-only code. Never continue. */
export class LiveKeyRefused extends Error {}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

export type StripeResult =
  | { kind: "ok"; status: number; body: Record<string, unknown> }
  /** Stripe refused it. Nothing was applied, so repeating it is safe. */
  | {
      kind: "rejected";
      status: number;
      reason: string;
      code?: string;
      retryable: boolean;
    }
  /** We cannot establish whether Stripe applied it. Only ever repeated with the
   * SAME idempotency key. */
  | { kind: "ambiguous"; reason: string };

/**
 * Accept only a test-mode secret or restricted key.
 *
 * The live prefix gets its own error because the two failures are not the same
 * incident: an unrecognised key is a configuration mistake, and a live key is a
 * near miss with real customer money that a human needs to hear about.
 */
export function assertTestKey(key: string): void {
  if (/^(sk|rk)_live_/.test(key)) {
    throw new LiveKeyRefused(
      "a LIVE-mode Stripe key was handed to test-mode-only code; refusing to " +
        "issue a single request. The control plane's Stripe work is test mode " +
        "only, and the live key belongs to the real company account.",
    );
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new LiveKeyRefused(
      "the Stripe key is not a recognisable test key (expected an sk_test_ or " +
        "rk_test_ prefix); refusing to issue a request rather than guess what " +
        "account it belongs to.",
    );
  }
}

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormValue[]
  | { [key: string]: FormValue };

/**
 * Stripe's bracketed form encoding: `subscription_data[metadata][account]=x`,
 * arrays indexed as `line_items[0][price]=y`.
 *
 * `undefined` is dropped so a caller can spread optional parameters; `null` is
 * sent, because Stripe uses an empty value to CLEAR a field and the two must not
 * collapse into one meaning.
 */
export function formEncode(params: Record<string, FormValue>): string {
  const parts: string[] = [];
  const walk = (prefix: string, value: FormValue): void => {
    if (value === undefined) return;
    if (value === null) {
      parts.push(`${encodeURIComponent(prefix)}=`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
      return;
    }
    parts.push(
      `${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`,
    );
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return parts.join("&");
}

export interface StripeClientOptions {
  key: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Retries of an AMBIGUOUS or rate-limited write, always with the same
   * idempotency key. */
  attempts?: number;
  /** Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export class StripeClient {
  private readonly key: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: StripeClientOptions) {
    // Before anything else. A constructed client is a client that can spend.
    assertTestKey(opts.key);
    this.key = opts.key;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async get(
    path: string,
    query: Record<string, FormValue> = {},
  ): Promise<StripeResult> {
    const qs = formEncode(query);
    return this.request("GET", qs ? `${path}?${qs}` : path);
  }

  /**
   * A write, with its idempotency key.
   *
   * The key is REQUIRED rather than optional: an unkeyed write cannot be safely
   * repeated, and a transport that silently allowed one would put the decision
   * about duplicate charges in whichever caller forgot.
   */
  async post(
    path: string,
    params: Record<string, FormValue>,
    idempotencyKey: string,
  ): Promise<StripeResult> {
    if (!idempotencyKey) {
      throw new Error(
        `refusing to POST ${path} without an idempotency key: an unkeyed write ` +
          `cannot be repeated safely`,
      );
    }
    let last: StripeResult = {
      kind: "ambiguous",
      reason: "no attempt was made",
    };
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      last = await this.request("POST", path, formEncode(params), {
        // The SAME key on every attempt. That is what makes the retry a replay
        // of one request rather than a second request.
        "Idempotency-Key": idempotencyKey,
      });
      if (last.kind === "ok") return last;
      if (last.kind === "rejected" && !last.retryable) return last;
      if (attempt + 1 < this.attempts) await this.sleep(500 * 2 ** attempt);
    }
    return last;
  }

  async del(path: string): Promise<StripeResult> {
    return this.request("DELETE", path);
  }

  private async request(
    method: string,
    path: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<StripeResult> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Stripe-Version": STRIPE_API_VERSION,
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/x-www-form-urlencoded" }),
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(body === undefined ? {} : { body }),
    };

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, init);
    } catch (err) {
      // Connection reset, DNS failure, our own timeout: all leave the request's
      // fate unknown. It may have been applied with only the response lost.
      return { kind: "ambiguous", reason: `transport failure: ${short(err)}` };
    }

    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    if (res.status >= 500) {
      return {
        kind: "ambiguous",
        reason: `Stripe returned HTTP ${res.status}`,
      };
    }
    if (!res.ok) {
      const err = errorOf(parsed);
      return {
        kind: "rejected",
        status: res.status,
        reason: err.reason,
        ...(err.code ? { code: err.code } : {}),
        // 429 and Stripe's own lock contention applied nothing, so repeating
        // them is safe; a 4xx about our parameters will fail identically.
        retryable: res.status === 429 || err.code === "lock_timeout",
      };
    }
    return {
      kind: "ok",
      status: res.status,
      body: (parsed ?? {}) as Record<string, unknown>,
    };
  }
}

/** The classified reason from a Stripe error body. Never the key: the key is a
 * header, so it cannot appear here, and nothing in this file interpolates it. */
function errorOf(body: unknown): { reason: string; code?: string } {
  const e = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!e) return { reason: "Stripe refused the request" };
  const type = typeof e.type === "string" ? e.type : "error";
  const code = typeof e.code === "string" ? e.code : undefined;
  const message =
    typeof e.message === "string" ? e.message : "no message given";
  return {
    reason: `${type}${code ? ` (${code})` : ""}: ${message}`,
    ...(code ? { code } : {}),
  };
}

function short(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
