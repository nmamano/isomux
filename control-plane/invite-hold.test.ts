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
    // The TTL is how long a live credential can sit in memory, so a change to
    // it is a decision, not a tweak: minutes, not hours.
    expect(INVITE_HOLD_MS).toBe(5 * 60_000);
    let now = 1_000_000;
    const hold = new InviteHold(() => now);
    hold.hold("op-1", "inst-1", URL);
    now += INVITE_HOLD_MS + 1;
    expect(hold.take("op-1", "inst-1")).toEqual({
      found: false,
      reason: "expired",
    });
    expect(hold.size()).toBe(0);
  });
});

describe("a new mint replaces the old link", () => {
  test("holding again for one instance drops the earlier entry", async () => {
    // Product rule, not housekeeping: minting again revokes the previous
    // unconsumed link on the box, so keeping the old one would leave a URL that
    // looks fine and cannot work.
    const hold = new InviteHold();
    hold.hold("op-1", "inst-1", URL);
    hold.hold("op-3", "inst-2", `${URL}-other`);
    hold.hold("op-2", "inst-1", `${URL}-second`);
    expect(hold.take("op-1", "inst-1")).toEqual({
      found: false,
      reason: "absent",
    });
    expect(hold.take("op-2", "inst-1")).toEqual({
      found: true,
      url: `${URL}-second`,
    });
    // Another instance's entry is untouched.
    expect(hold.take("op-3", "inst-2")).toEqual({
      found: true,
      url: `${URL}-other`,
    });
  });
});
