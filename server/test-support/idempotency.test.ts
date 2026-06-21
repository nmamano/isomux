// Phase 2.3 — Idempotency middleware contract tests (TDD red→green for NEW code).
//
// Pins the standalone semantics (not wired live in 2.3): key by stable identity
// SUBJECT (never the raw token) + method + opId + Idempotency-Key + body hash;
// same key+body replays; same key+different body 409s; no key = no caching; TTL
// expiry re-runs; in-flight COLLAPSE for concurrent retries; failures not cached.
//
// Pure T1-ish: deterministic clock injected, no server/FS/LLM.

import { describe, it, expect } from "bun:test";
import {
  createIdempotencyCache,
  identitySubjectKey,
  hashBody,
} from "../transport/idempotency.ts";
import type { Identity } from "../identity/index.ts";
import { expectRejection } from "./expect-rejection.ts";

const user: Identity = {
  scope: "user",
  userId: "u1",
  role: "owner",
  capabilities: [],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("idempotency: identitySubjectKey is stable and token-free", () => {
  it("scopes by kind so a user and an agent sharing an id don't collide", () => {
    expect(identitySubjectKey(user)).toBe("user:u1");
    expect(
      identitySubjectKey({
        scope: "agent",
        userId: "x",
        agentId: "u1",
        role: "member",
        capabilities: [],
      }),
    ).toBe("agent:u1");
    expect(
      identitySubjectKey({
        scope: "cron-run",
        userId: "x",
        cronjobId: "j1",
        runId: "r1",
        role: "member",
        capabilities: [],
      }),
    ).toBe("cron-run:j1:r1");
  });
});

describe("idempotency: caching semantics", () => {
  it("no key ⇒ runs, never caches", async () => {
    const cache = createIdempotencyCache();
    let calls = 0;
    const r1 = await cache.run(
      {
        identity: user,
        method: "POST",
        opId: "tasks.create",
        idempotencyKey: null,
        rawBody: "{}",
      },
      async () => ++calls,
    );
    expect(r1).toEqual({ kind: "ran", response: 1 });
    expect(cache._size()).toBe(0);
  });

  it("same key + same body ⇒ replay (handler runs once)", async () => {
    const cache = createIdempotencyCache();
    let calls = 0;
    const args = {
      identity: user,
      method: "POST",
      opId: "tasks.create",
      idempotencyKey: "k1",
      rawBody: '{"title":"a"}',
    };
    const a = await cache.run(args, async () => ++calls);
    const b = await cache.run(args, async () => ++calls);
    expect(a).toEqual({ kind: "ran", response: 1 });
    expect(b).toEqual({ kind: "replayed", response: 1 });
    expect(calls).toBe(1);
  });

  it("same key + DIFFERENT body ⇒ 409 conflict (handler not run again)", async () => {
    const cache = createIdempotencyCache();
    let calls = 0;
    const base = {
      identity: user,
      method: "POST",
      opId: "tasks.create",
      idempotencyKey: "k1",
    };
    await cache.run({ ...base, rawBody: '{"title":"a"}' }, async () => ++calls);
    const conflict = await cache.run(
      { ...base, rawBody: '{"title":"b"}' },
      async () => ++calls,
    );
    expect(conflict).toEqual({ kind: "conflict" });
    expect(calls).toBe(1);
  });

  it("different key ⇒ both run", async () => {
    const cache = createIdempotencyCache();
    let calls = 0;
    const base = {
      identity: user,
      method: "POST",
      opId: "tasks.create",
      rawBody: "{}",
    };
    await cache.run({ ...base, idempotencyKey: "k1" }, async () => ++calls);
    await cache.run({ ...base, idempotencyKey: "k2" }, async () => ++calls);
    expect(calls).toBe(2);
  });

  it("same key on a DIFFERENT route does not replay (opId namespaces the key)", async () => {
    const cache = createIdempotencyCache();
    let calls = 0;
    await cache.run(
      {
        identity: user,
        method: "POST",
        opId: "tasks.create",
        idempotencyKey: "k",
        rawBody: "{}",
      },
      async () => ++calls,
    );
    const other = await cache.run(
      {
        identity: user,
        method: "POST",
        opId: "rooms.create",
        idempotencyKey: "k",
        rawBody: "{}",
      },
      async () => ++calls,
    );
    expect(other.kind).toBe("ran");
    expect(calls).toBe(2);
  });

  it("a different identity subject does not collide", async () => {
    const cache = createIdempotencyCache();
    let calls = 0;
    const agent: Identity = {
      scope: "agent",
      userId: "x",
      agentId: "u1",
      role: "member",
      capabilities: [],
    };
    const base = {
      method: "POST",
      opId: "tasks.create",
      idempotencyKey: "k",
      rawBody: "{}",
    };
    await cache.run({ ...base, identity: user }, async () => ++calls);
    const agentRun = await cache.run(
      { ...base, identity: agent },
      async () => ++calls,
    );
    expect(agentRun.kind).toBe("ran"); // "user:u1" ≠ "agent:u1"
    expect(calls).toBe(2);
  });
});

describe("idempotency: TTL expiry (injected clock)", () => {
  it("re-runs after the entry expires", async () => {
    let clock = 1000;
    const cache = createIdempotencyCache({ now: () => clock, ttlMs: 5000 });
    let calls = 0;
    const args = {
      identity: user,
      method: "POST",
      opId: "tasks.create",
      idempotencyKey: "k1",
      rawBody: "{}",
    };
    await cache.run(args, async () => ++calls); // stored, expires at 6000
    clock = 5999;
    const replay = await cache.run(args, async () => ++calls);
    expect(replay).toEqual({ kind: "replayed", response: 1 });
    clock = 6001; // past TTL
    const rerun = await cache.run(args, async () => ++calls);
    expect(rerun).toEqual({ kind: "ran", response: 2 });
    expect(calls).toBe(2);
  });
});

describe("idempotency: in-flight collapse", () => {
  it("concurrent same key+body collapses to ONE handler run", async () => {
    const cache = createIdempotencyCache();
    let calls = 0;
    const gate = deferred<void>();
    const args = {
      identity: user,
      method: "POST",
      opId: "tasks.create",
      idempotencyKey: "k1",
      rawBody: "{}",
    };
    const handler = async () => {
      calls++;
      await gate.promise;
      return "done";
    };
    const p1 = cache.run(args, handler);
    const p2 = cache.run(args, handler); // arrives while p1 in-flight
    gate.resolve();
    const [a, b] = await Promise.all([p1, p2]);
    expect(calls).toBe(1); // collapsed, not double-run
    expect(a.kind).toBe("ran");
    expect(b.kind).toBe("replayed");
    expect((a as { response: string }).response).toBe("done");
    expect((b as { response: string }).response).toBe("done");
  });

  it("concurrent same key + DIFFERENT body still 409s while in-flight", async () => {
    const cache = createIdempotencyCache();
    const gate = deferred<void>();
    const base = {
      identity: user,
      method: "POST",
      opId: "tasks.create",
      idempotencyKey: "k1",
    };
    const p1 = cache.run({ ...base, rawBody: '{"v":1}' }, async () => {
      await gate.promise;
      return "first";
    });
    const conflict = await cache.run(
      { ...base, rawBody: '{"v":2}' },
      async () => "second",
    );
    expect(conflict).toEqual({ kind: "conflict" });
    gate.resolve();
    await p1;
  });
});

describe("idempotency: failures are not cached", () => {
  it("a rejected handler evicts the entry so a retry re-runs", async () => {
    const cache = createIdempotencyCache();
    let calls = 0;
    const args = {
      identity: user,
      method: "POST",
      opId: "tasks.create",
      idempotencyKey: "k1",
      rawBody: "{}",
    };
    await expectRejection(
      cache.run(args, async () => {
        calls++;
        throw new Error("boom");
      }),
      /boom/,
    );
    expect(cache._size()).toBe(0); // evicted
    const retry = await cache.run(args, async () => ++calls);
    expect(retry).toEqual({ kind: "ran", response: 2 });
    expect(calls).toBe(2);
  });
});

describe("idempotency: hashBody", () => {
  it("identical bodies hash identically; different bodies diverge", () => {
    expect(hashBody('{"a":1}')).toBe(hashBody('{"a":1}'));
    expect(hashBody('{"a":1}')).not.toBe(hashBody('{"a":2}'));
    expect(hashBody("")).toBe(hashBody(""));
  });
});
