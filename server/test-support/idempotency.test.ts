// Idempotency cache contract tests. Replay, conflict, no-key, in-flight
// collapse and failure eviction are owned by route-executor.test.ts, which
// drives the cache through the executor. This file keeps what the executor
// tests do not reach: how the key is namespaced (key, route, and identity
// subject), TTL expiry, and the body check while a call is in flight.
//
// Pure T1-ish: deterministic clock injected, no server/FS/LLM.

import { describe, it, expect } from "bun:test";
import { createIdempotencyCache } from "../transport/idempotency.ts";
import type { Identity } from "../identity/index.ts";

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

describe("idempotency: the key is namespaced", () => {
  const agentU1: Identity = {
    scope: "agent",
    userId: "x",
    agentId: "u1",
    role: "member",
    capabilities: [],
  };
  const app = (appName: string): Identity => ({
    scope: "app",
    userId: "u1",
    appName,
    role: "member",
    capabilities: [],
  });
  const api = (apiTokenId: string): Identity => ({
    scope: "api",
    userId: "u1",
    apiTokenId,
    apiTokenName: apiTokenId,
    role: "member",
    capabilities: [],
  });
  const run = (runId: string): Identity => ({
    scope: "cron-run",
    userId: "u1",
    cronjobId: "j1",
    runId,
    role: "member",
    capabilities: [],
  });
  const base = {
    identity: user,
    method: "POST",
    opId: "tasks.create",
    idempotencyKey: "k",
    bodyFingerprint: "{}",
  };
  // Each row: a first call, then a second call that differs in one part of
  // the key. The second must run, never replay.
  const rows: Array<[string, typeof base, typeof base]> = [
    ["a different key", base, { ...base, idempotencyKey: "k2" }],
    ["a different route", base, { ...base, opId: "rooms.create" }],
    // "user:u1" and "agent:u1" share an id.
    ["a user and an agent with one id", base, { ...base, identity: agentU1 }],
    // Two agents of one member key on their own ids, not on the member's.
    [
      "two agents of one member",
      { ...base, identity: { ...agentU1, userId: "m1", agentId: "a1" } },
      { ...base, identity: { ...agentU1, userId: "m1", agentId: "a2" } },
    ],
    // An app keys on its own name, not on the owner it shares.
    [
      "two apps of one owner",
      { ...base, identity: app("hello") },
      { ...base, identity: app("other") },
    ],
    [
      "two API tokens of one user",
      { ...base, identity: api("pat-1") },
      { ...base, identity: api("pat-2") },
    ],
    [
      "two runs of one cronjob",
      { ...base, identity: run("r1") },
      { ...base, identity: run("r2") },
    ],
  ];
  for (const [name, first, second] of rows) {
    it(`${name} does not replay`, async () => {
      const cache = createIdempotencyCache();
      let calls = 0;
      await cache.run(first, async () => ++calls);
      // The same call replays: the row's difference is what makes it run.
      expect((await cache.run(first, async () => ++calls)).kind).toBe(
        "replayed",
      );
      expect(await cache.run(second, async () => ++calls)).toEqual({
        kind: "ran",
        response: 2,
      });
    });
  }
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
      bodyFingerprint: "{}",
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

describe("idempotency: in flight", () => {
  it("concurrent same key + DIFFERENT body still 409s while in-flight", async () => {
    const cache = createIdempotencyCache();
    const gate = deferred<void>();
    const base = {
      identity: user,
      method: "POST",
      opId: "tasks.create",
      idempotencyKey: "k1",
    };
    const p1 = cache.run({ ...base, bodyFingerprint: '{"v":1}' }, async () => {
      await gate.promise;
      return "first";
    });
    // The body check runs before the second call awaits anything, so opening
    // the gate right away cannot change its answer; a cache that skipped the
    // check would collapse onto the first call and report it replayed.
    const second = cache.run(
      { ...base, bodyFingerprint: '{"v":2}' },
      async () => "second",
    );
    gate.resolve();
    const [conflict] = await Promise.all([second, p1]);
    expect(conflict).toEqual({ kind: "conflict" });
  });
});
