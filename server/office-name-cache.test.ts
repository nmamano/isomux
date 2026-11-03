// The office name cache behind GET /api/floors/name (task 42be5397): one card
// probe per origin, shared by every caller, kept for a TTL (failures too),
// at most a fixed number of origins, and a limit on the probes one caller has
// in flight. The route test (server/test-support/routes-floors-rest.test.ts)
// covers the HTTP shape over real listeners; this file covers the clock and
// the bookkeeping, which a real listener cannot drive.

import { describe, expect, it } from "bun:test";
import {
  createOfficeNameCache,
  OFFICE_NAME_MAX_IN_FLIGHT,
  type OfficeNameLookup,
} from "./office-name-cache.ts";
import type { OfficeCard } from "../shared/floors.ts";

type Answer = OfficeCard | "outdated" | null;

const origin = (i: number) => `https://o${i}.example.com`;
// Lets a lookup reach its probe, whether or not it awaits on the way.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A probe whose answers the test releases by hand.
function heldProbe() {
  const calls: string[] = [];
  const pending = new Map<string, Array<(a: Answer) => void>>();
  return {
    calls,
    probe(o: string): Promise<Answer> {
      calls.push(o);
      return new Promise((resolve) => {
        pending.set(o, [...(pending.get(o) ?? []), resolve]);
      });
    },
    release(o: string, answer: Answer) {
      for (const resolve of pending.get(o) ?? []) resolve(answer);
      pending.delete(o);
    },
  };
}

// A probe that answers at once from a table, and counts its calls.
function tableProbe(table: Record<string, Answer>) {
  const calls: string[] = [];
  return {
    calls,
    probe: async (o: string): Promise<Answer> => {
      calls.push(o);
      return table[o] ?? null;
    },
  };
}

describe("createOfficeNameCache", () => {
  it("answers a card with its name, and a failed or outdated probe as failed", async () => {
    const p = tableProbe({
      [origin(1)]: { isomux: 1, name: "Harbor" },
      [origin(2)]: { isomux: 1, name: null },
      [origin(3)]: "outdated",
      [origin(4)]: null,
    });
    const cache = createOfficeNameCache({ probe: p.probe });
    const answers: OfficeNameLookup[] = [];
    for (const i of [1, 2, 3, 4])
      answers.push(await cache.lookup(origin(i), "m"));
    expect(answers).toEqual([
      { kind: "card", name: "Harbor" },
      { kind: "card", name: null },
      { kind: "failed" },
      { kind: "failed" },
    ]);
  });

  it("probes an origin once per TTL for every caller, failures included", async () => {
    let now = 1_000;
    const p = tableProbe({ [origin(1)]: { isomux: 1, name: "Harbor" } });
    const cache = createOfficeNameCache({
      probe: p.probe,
      now: () => now,
      ttlMs: 100,
    });
    await cache.lookup(origin(1), "m1");
    await cache.lookup(origin(2), "m1");
    now += 99;
    expect(await cache.lookup(origin(1), "m2")).toEqual({
      kind: "card",
      name: "Harbor",
    });
    expect(await cache.lookup(origin(2), "m2")).toEqual({ kind: "failed" });
    expect(p.calls).toEqual([origin(1), origin(2)]);
    now += 2;
    await cache.lookup(origin(1), "m1");
    await cache.lookup(origin(2), "m1");
    expect(p.calls).toEqual([origin(1), origin(2), origin(1), origin(2)]);
  });

  it("shares one probe between callers that ask for one origin at once", async () => {
    const p = heldProbe();
    const cache = createOfficeNameCache({ probe: p.probe });
    const first = cache.lookup(origin(1), "m1");
    const second = cache.lookup(origin(1), "m2");
    const third = cache.lookup(origin(1), "m1");
    await settle();
    expect(p.calls).toEqual([origin(1)]);
    p.release(origin(1), { isomux: 1, name: "Harbor" });
    const card: OfficeNameLookup = { kind: "card", name: "Harbor" };
    expect(await Promise.all([first, second, third])).toEqual([
      card,
      card,
      card,
    ]);
  });

  it("keeps at most maxOrigins answers, dropping the oldest", async () => {
    const p = tableProbe({});
    const cache = createOfficeNameCache({ probe: p.probe, maxOrigins: 2 });
    for (const i of [1, 2, 3]) await cache.lookup(origin(i), "m");
    await cache.lookup(origin(3), "m");
    await cache.lookup(origin(2), "m");
    expect(p.calls).toEqual([origin(1), origin(2), origin(3)]);
    await cache.lookup(origin(1), "m");
    expect(p.calls).toEqual([origin(1), origin(2), origin(3), origin(1)]);
  });

  it("answers busy past the in-flight limit of one caller, without a probe, and frees the slot when a probe ends", async () => {
    const p = heldProbe();
    const cache = createOfficeNameCache({ probe: p.probe });
    const held = Array.from({ length: OFFICE_NAME_MAX_IN_FLIGHT }, (_, i) =>
      cache.lookup(origin(i), "m1"),
    );
    await settle();
    expect(await cache.lookup(origin(99), "m1")).toEqual({ kind: "busy" });
    await settle();
    expect(p.calls).not.toContain(origin(99));
    // Another caller has slots of its own.
    const other = cache.lookup(origin(98), "m2");
    await settle();
    expect(p.calls).toContain(origin(98));
    // A caller that joins another caller's probe uses a slot of its own.
    const joined = Array.from(
      { length: OFFICE_NAME_MAX_IN_FLIGHT - 1 },
      (_, i) => cache.lookup(origin(i), "m2"),
    );
    expect(await cache.lookup(origin(97), "m2")).toEqual({ kind: "busy" });

    p.release(origin(0), { isomux: 1, name: "Zero" });
    expect(await held[0]).toEqual({ kind: "card", name: "Zero" });
    p.release(origin(98), null);
    await other;
    const next = cache.lookup(origin(99), "m1");
    await settle();
    expect(p.calls).toContain(origin(99));
    for (let i = 1; i < OFFICE_NAME_MAX_IN_FLIGHT; i++)
      p.release(origin(i), null);
    p.release(origin(99), null);
    await Promise.all([...held, ...joined, next]);
  });

  it("answers a cached origin while the caller is at its limit", async () => {
    const p = heldProbe();
    const cache = createOfficeNameCache({ probe: p.probe });
    const first = cache.lookup(origin(50), "m1");
    p.release(origin(50), { isomux: 1, name: "Cached" });
    await first;
    const held = Array.from({ length: OFFICE_NAME_MAX_IN_FLIGHT }, (_, i) =>
      cache.lookup(origin(i), "m1"),
    );
    await settle();
    expect(await cache.lookup(origin(98), "m1")).toEqual({ kind: "busy" });
    expect(await cache.lookup(origin(50), "m1")).toEqual({
      kind: "card",
      name: "Cached",
    });
    for (let i = 0; i < OFFICE_NAME_MAX_IN_FLIGHT; i++)
      p.release(origin(i), null);
    await Promise.all(held);
  });

  it("answers failed when the probe throws, and frees the caller's slot", async () => {
    let calls = 0;
    const cache = createOfficeNameCache({
      probe: async () => {
        calls++;
        throw new Error("probe broke");
      },
      maxInFlightPerCaller: 1,
    });
    expect(await cache.lookup(origin(1), "m")).toEqual({ kind: "failed" });
    // The slot is free again: the next origin is probed, not refused busy.
    expect(await cache.lookup(origin(2), "m")).toEqual({ kind: "failed" });
    expect(calls).toBe(2);
  });
});
