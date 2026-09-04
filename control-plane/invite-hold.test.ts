// The one-shot hold: taken once, expired twice over, and never shared.

import { describe, expect, test } from "bun:test";
import { InviteHold, INVITE_HOLD_MS } from "./invite-hold.ts";

const URL = "https://cp1.test.isomux.app/i/holdsecret";

describe("one shot", () => {
  test("the first taker gets it and the second gets nothing", async () => {
    const hold = new InviteHold();
    hold.hold("op-1", "inst-1", URL);
    expect(hold.take("op-1", "inst-1")).toEqual({ found: true, url: URL });
    expect(hold.take("op-1", "inst-1")).toEqual({
      found: false,
      reason: "absent",
    });
    expect(hold.size()).toBe(0);
  });

  test("racing takers cannot both win", async () => {
    // take() must not yield between reading and deleting. Two callers
    // interleaved as tightly as this runtime allows still produce one winner;
    // if an await appeared inside take, this is what would start failing.
    const hold = new InviteHold();
    hold.hold("op-1", "inst-1", URL);
    const results = [
      hold.take("op-1", "inst-1"),
      hold.take("op-1", "inst-1"),
      hold.take("op-1", "inst-1"),
    ];
    expect(results.filter((r) => r.found)).toHaveLength(1);
  });

  test("the wrong instance is answered like an absent one", async () => {
    const hold = new InviteHold();
    hold.hold("op-1", "inst-1", URL);
    expect(hold.take("op-1", "inst-2")).toEqual({
      found: false,
      reason: "absent",
    });
    // And it is still there for its rightful owner: a wrong-instance ask must
    // not consume somebody else's link.
    expect(hold.take("op-1", "inst-1")).toEqual({ found: true, url: URL });
  });
});

describe("expiry", () => {
  test("a stale entry is refused even if its timer has not run", async () => {
    // The LAZY half. A process suspended past the deadline would otherwise hand
    // over a link that the scheduled timer had not got round to dropping.
    let now = 1_000_000;
    const hold = new InviteHold(() => now, 60_000);
    hold.hold("op-1", "inst-1", URL);
    now += 60_001;
    expect(hold.take("op-1", "inst-1")).toEqual({
      found: false,
      reason: "expired",
    });
    expect(hold.size()).toBe(0);
  });

  test("the TTL is minutes, not hours", async () => {
    // A guard on the constant itself: this value is how long a live credential
    // can sit in memory, so a change to it is a decision, not a tweak.
    expect(INVITE_HOLD_MS).toBe(5 * 60_000);
  });
});

describe("a new mint replaces the old link", () => {
  test("holding again for one instance drops the earlier entry", async () => {
    // Product rule, not housekeeping: minting again revokes the previous
    // unconsumed link on the box, so keeping the old one would leave a URL that
    // looks fine and cannot work.
    const hold = new InviteHold();
    hold.hold("op-1", "inst-1", URL);
    hold.hold("op-2", "inst-1", `${URL}-second`);
    expect(hold.take("op-1", "inst-1")).toEqual({
      found: false,
      reason: "absent",
    });
    expect(hold.take("op-2", "inst-1")).toEqual({
      found: true,
      url: `${URL}-second`,
    });
  });

  test("another instance's entry is untouched", async () => {
    const hold = new InviteHold();
    hold.hold("op-1", "inst-1", URL);
    hold.hold("op-2", "inst-2", `${URL}-other`);
    expect(hold.size()).toBe(2);
    expect(hold.take("op-1", "inst-1")).toEqual({ found: true, url: URL });
  });
});

test("drop removes without reading", async () => {
  const hold = new InviteHold();
  hold.hold("op-1", "inst-1", URL);
  hold.drop("op-1");
  expect(hold.size()).toBe(0);
  expect(hold.take("op-1", "inst-1").found).toBe(false);
});
