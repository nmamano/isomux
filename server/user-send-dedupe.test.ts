import { describe, it, expect } from "bun:test";
import { createUserSendDedupe } from "./user-send-dedupe.ts";

const refused = {
  ok: false,
  status: 429,
  code: "queue_full",
  message: "queue_full",
} as const;

describe("createUserSendDedupe", () => {
  it("answers an accepted key as accepted, per agent", () => {
    const d = createUserSendDedupe();
    const first = d.claim("a1", "k");
    expect(first.kind).toBe("new");
    if (first.kind === "new") first.settle({ ok: true });
    expect(d.claim("a1", "k").kind).toBe("accepted");
    expect(d.claim("a2", "k").kind).toBe("new");
  });

  it("forgets a refused key so the attempt can be resent", () => {
    const d = createUserSendDedupe();
    const first = d.claim("a1", "k");
    if (first.kind === "new") first.settle(refused);
    expect(d.claim("a1", "k").kind).toBe("new");
  });

  it("hands an in-flight key's outcome to a concurrent duplicate", async () => {
    const d = createUserSendDedupe();
    const first = d.claim("a1", "k");
    const dup = d.claim("a1", "k");
    expect(dup.kind).toBe("in_flight");
    if (first.kind === "new") first.settle(refused);
    if (dup.kind === "in_flight") expect(await dup.wait).toEqual(refused);
  });

  it("drops the oldest accepted keys past the count bound", () => {
    const d = createUserSendDedupe({ maxPerAgent: 2 });
    for (const key of ["k1", "k2", "k3"]) {
      const c = d.claim("a1", key);
      if (c.kind === "new") c.settle({ ok: true });
    }
    // The next claim prunes down to the bound before it looks the key up.
    expect(d.claim("a1", "k1").kind).toBe("new");
    expect(d.claim("a1", "k3").kind).toBe("accepted");
  });

  it("drops accepted keys past their age", () => {
    let t = 0;
    const d = createUserSendDedupe({ ttlMs: 1000, now: () => t });
    const c = d.claim("a1", "k");
    if (c.kind === "new") c.settle({ ok: true });
    t = 999;
    expect(d.claim("a1", "k").kind).toBe("accepted");
    t = 2001;
    expect(d.claim("a1", "k").kind).toBe("new");
  });

  it("forgetAgent clears that agent's keys", () => {
    const d = createUserSendDedupe();
    const c = d.claim("a1", "k");
    if (c.kind === "new") c.settle({ ok: true });
    d.forgetAgent("a1");
    expect(d.claim("a1", "k").kind).toBe("new");
  });
});
