// Contabo REST transport.
//
// Every call returns a classified RESULT rather than throwing, because the
// distinction this file exists to draw is the one that costs money: a request
// that was REJECTED did not spend anything, while a request whose fate we
// cannot establish may already have. Callers that spend money (create) must see
// that difference; callers that do not can use `okOrThrow`.
//
// `x-request-id` is sent on every call because Contabo requires it, and for no
// other reason. Their documentation defines it as "Uuid4 to identify individual
// requests for support cases" - a support-correlation id. It is NOT an
// idempotency key, Contabo documents no idempotency mechanism for the paid
// create endpoint, and nothing here may treat a repeated id as replay-safe.

import type { FetchLike } from "./auth.ts";
import type { TokenProvider } from "./auth.ts";

export const CONTABO_API_BASE = "https://api.contabo.com";

export type HttpResult =
  | { kind: "ok"; status: number; body: unknown }
  /** The provider refused. Nothing was applied, so a retry is safe. */
  | { kind: "rejected"; status: number; reason: string }
  /** We cannot establish whether the provider applied it. Never retried. */
  | { kind: "ambiguous"; reason: string };

export interface ContaboHttpOptions {
  fetchImpl: FetchLike;
  tokens: TokenProvider;
  /** Injected so tests get deterministic ids. */
  requestId?: () => string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ContaboHttp {
  private readonly fetchImpl: FetchLike;
  private readonly tokens: TokenProvider;
  private readonly requestId: () => string;
  private readonly timeoutMs: number;

  constructor(opts: ContaboHttpOptions) {
    this.fetchImpl = opts.fetchImpl;
    this.tokens = opts.tokens;
    this.requestId = opts.requestId ?? (() => crypto.randomUUID());
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HttpResult> {
    let token: string;
    try {
      token = await this.tokens.token();
    } catch (err) {
      // Failing to obtain a token means the request was never issued, so this
      // is a rejection and not an ambiguity - nothing reached the provider.
      return {
        kind: "rejected",
        status: 0,
        reason: `authentication failed: ${messageOf(err)}`,
      };
    }
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-request-id": this.requestId(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${CONTABO_API_BASE}${path}`, init);
    } catch (err) {
      // A thrown fetch covers connection resets, DNS failure and our own
      // timeout. All of them leave the request's fate unknown: it may have been
      // delivered and processed with only the response lost.
      return {
        kind: "ambiguous",
        reason: `transport failure: ${messageOf(err)}`,
      };
    }

    if (res.status >= 500 || res.status === 408) {
      // A 5xx can be raised before or after the provider applied the change,
      // and their API does not say which.
      return {
        kind: "ambiguous",
        reason: `provider returned HTTP ${res.status}`,
      };
    }
    if (!res.ok) {
      return {
        kind: "rejected",
        status: res.status,
        reason: `provider returned HTTP ${res.status}`,
      };
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // A 2xx with an unreadable body still means the operation was applied.
      parsed = null;
    }
    return { kind: "ok", status: res.status, body: parsed };
  }

  /**
   * For operations where an ambiguous outcome costs nothing to redo (get,
   * power actions, find). Money-spending callers must handle `request`'s
   * classification themselves rather than reach for this.
   */
  async okOrThrow(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const r = await this.request(method, path, body);
    if (r.kind === "ok") return r.body;
    throw new Error(`${method} ${path}: ${r.reason}`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
