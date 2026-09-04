// Centralized Idempotency-Key middleware. Idempotency lives at the
// transport layer, not per-endpoint. See
// internal-docs/generic-runtime-refactor.md → Conventions "Idempotency".
//
// A mutating POST MAY carry an `Idempotency-Key`. The cache keys by
// (stable identity SUBJECT, method, normalized opId, key) plus a request-body
// hash, with a short in-memory TTL:
//   - same key + same body  → replay the stored response (handler NOT re-run)
//   - same key + different body → 409 conflict (a key reused across endpoints or
//     with a changed body can never replay the wrong response)
//   - no key → no caching (optional per request; agents/curl aren't forced to send one)
//
// The subject is the STABLE IDENTITY (scope:userId / scope:agentId /
// scope:cronjobId:runId) - NEVER the raw bearer token, which must never enter a
// cache key, log, or error. In-flight COLLAPSE: a concurrent retry with the same
// key+body awaits the first call's result rather than double-running the handler;
// a concurrent same-key call with a DIFFERENT body still 409s. Failures are NOT
// cached (a rejected handler evicts the in-flight entry so a retry re-runs).

import { createHash } from "crypto";
import type { Identity } from "../identity/index.ts";

// The stable subject for the cache key. Scope-prefixed so a user and an agent
// that happen to share a userId never collide, and so the raw token never
// appears. Empty id segments are tolerated (they still scope by kind).
export function identitySubjectKey(identity: Identity): string {
  switch (identity.scope) {
    case "user":
      return `user:${identity.userId ?? ""}`;
    case "agent":
      return `agent:${identity.agentId ?? ""}`;
    case "cron-run":
      return `cron-run:${identity.cronjobId ?? ""}:${identity.runId ?? ""}`;
    case "app":
      return `app:${identity.appName ?? ""}`;
    case "api":
      return `api:${identity.apiTokenId ?? ""}`;
  }
}

// sha256 of the raw request-body bytes. The caller passes the exact serialized
// body it received, so a byte-identical retry hashes identically and a changed
// body diverges. An absent body hashes the empty string.
export function hashBody(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

// What the middleware did, surfaced so the transport can map it to a status:
//   ran      → handler executed; response is its result (201/200/204 as usual)
//   replayed → a prior identical request's stored response (handler NOT re-run)
//   conflict → same key, different body → 409
export type IdempotencyOutcome<R> =
  | { kind: "ran"; response: R }
  | { kind: "replayed"; response: R }
  | { kind: "conflict" };

interface PendingEntry {
  state: "pending";
  bodyHash: string;
  promise: Promise<unknown>;
}
interface DoneEntry {
  state: "done";
  bodyHash: string;
  response: unknown;
  expiresAt: number;
}
type Entry = PendingEntry | DoneEntry;

export interface IdempotencyOptions {
  // Clock seam for deterministic TTL tests (mirrors CronjobManager's clock DI).
  now?: () => number;
  // Completed-entry lifetime. Default 5 minutes, matching today's
  // clientMessageId dedup window (QUEUE_DEDUPE_TTL_MS).
  ttlMs?: number;
}

export interface IdempotencyCache {
  // Run `handler` under idempotency. `idempotencyKey` null ⇒ no caching (just
  // run). `method`/`opId` namespace the key so a key reused on a different
  // route can't replay. `rawBody` is the exact received body string (hashed).
  run<R>(
    args: {
      identity: Identity;
      method: string;
      opId: string;
      idempotencyKey: string | null;
      rawBody: string;
    },
    handler: () => Promise<R>,
  ): Promise<IdempotencyOutcome<R>>;
  // Test/introspection helpers.
  _size(): number;
  _reset(): void;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createIdempotencyCache(
  opts: IdempotencyOptions = {},
): IdempotencyCache {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const store = new Map<string, Entry>();

  function composeKey(
    subject: string,
    method: string,
    opId: string,
    key: string,
  ): string {
    // NUL-joined so no segment boundary can be forged by an embedded delimiter.
    return `${subject}\u0000${method}\u0000${opId}\u0000${key}`;
  }

  function pruneExpired(t: number): void {
    for (const [k, e] of store) {
      if (e.state === "done" && e.expiresAt <= t) store.delete(k);
    }
  }

  async function run<R>(
    args: {
      identity: Identity;
      method: string;
      opId: string;
      idempotencyKey: string | null;
      rawBody: string;
    },
    handler: () => Promise<R>,
  ): Promise<IdempotencyOutcome<R>> {
    // No key ⇒ retry protection opted out; just run.
    if (args.idempotencyKey === null || args.idempotencyKey === "") {
      return { kind: "ran", response: await handler() };
    }

    const t = now();
    pruneExpired(t);

    const bodyHash = hashBody(args.rawBody);
    const cacheKey = composeKey(
      identitySubjectKey(args.identity),
      args.method,
      args.opId,
      args.idempotencyKey,
    );

    const existing = store.get(cacheKey);
    if (existing) {
      // Same key, different body ⇒ conflict (never replay the wrong response).
      if (existing.bodyHash !== bodyHash) return { kind: "conflict" };
      if (existing.state === "pending") {
        // In-flight collapse: await the first call rather than double-running.
        const response = (await existing.promise) as R;
        return { kind: "replayed", response };
      }
      return { kind: "replayed", response: existing.response as R };
    }

    // First call for this key: mark in-flight so concurrent retries collapse.
    const promise = handler();
    store.set(cacheKey, { state: "pending", bodyHash, promise });
    try {
      const response = await promise;
      // Cache only on success; a TTL'd entry now replays identical retries.
      store.set(cacheKey, {
        state: "done",
        bodyHash,
        response,
        expiresAt: now() + ttlMs,
      });
      return { kind: "ran", response };
    } catch (err) {
      // Don't cache failures - evict so a retry re-runs rather than replaying a
      // transient error for the whole TTL window.
      const cur = store.get(cacheKey);
      if (cur && cur.state === "pending") store.delete(cacheKey);
      throw err;
    }
  }

  return {
    run,
    _size: () => store.size,
    _reset: () => store.clear(),
  };
}
