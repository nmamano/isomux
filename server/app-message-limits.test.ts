// App-message rate limits: the two budgets, when each is spent, and - the part
// that matters to a caller trying to behave - whether retryAfterSec is a time at
// which the request would ACTUALLY succeed.
//
// Pure T0: an injected clock, no server, no disk, no LLM.

import { describe, it, expect } from "bun:test";
import {
  APP_MESSAGE_BURST_LIMIT,
  APP_MESSAGE_BURST_WINDOW_MS,
  APP_MESSAGE_DAILY_CAP,
  APP_MESSAGE_DAILY_WINDOW_MS,
  createAppMessageLimiter,
} from "./app-message-limits.ts";

// A limiter over a clock the test moves by hand.
function limiterAt(start = 1_000_000) {
  let t = start;
  const limiter = createAppMessageLimiter({ now: () => t });
  return {
    limiter,
    advance: (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

describe("app-message limits: the burst budget", () => {
  it("allows the limit and refuses the next", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      expect({ i, ok: limiter.takeBurst("hello").ok }).toEqual({ i, ok: true });
    }
    expect(limiter.takeBurst("hello")).toEqual({
      ok: false,
      kind: "burst",
      retryAfterSec: APP_MESSAGE_BURST_WINDOW_MS / 1000,
    });
  });

  it("refills as the window slides, one slot at a time", () => {
    const { limiter, advance } = limiterAt();
    // Spend the whole burst, one message per second.
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      expect(limiter.takeBurst("hello").ok).toBe(true);
      advance(1000);
    }
    // The oldest is now BURST_LIMIT seconds old, so the wait is what remains of
    // its window - not the whole window.
    const denied = limiter.takeBurst("hello");
    expect(denied).toEqual({
      ok: false,
      kind: "burst",
      retryAfterSec:
        APP_MESSAGE_BURST_WINDOW_MS / 1000 - APP_MESSAGE_BURST_LIMIT,
    });

    // Waiting exactly that long lets exactly ONE message through: the advice is
    // accurate, and it is not a full refill.
    if (!denied.ok) advance(denied.retryAfterSec * 1000);
    expect(limiter.takeBurst("hello").ok).toBe(true);
    expect(limiter.takeBurst("hello").ok).toBe(false);
  });

  it("is per app - one app's loop cannot spend another's budget", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      limiter.takeBurst("noisy");
    }
    expect(limiter.takeBurst("noisy").ok).toBe(false);
    expect(limiter.takeBurst("quiet").ok).toBe(true);
  });

  it("never advises retrying in 0 seconds", () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++)
      limiter.takeBurst("hello");
    // 1ms short of the window: rounded UP to 1s, never down to 0 (which a
    // caller reads as "retry now" and is refused again).
    advance(APP_MESSAGE_BURST_WINDOW_MS - 1);
    const denied = limiter.takeBurst("hello");
    expect(denied).toEqual({ ok: false, kind: "burst", retryAfterSec: 1 });
  });

  it("rounds a partial second UP, so retrying at the advised time succeeds", () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++)
      limiter.takeBurst("hello");
    // 500ms in: 59.5s remain, which must be advised as 60 rather than 59 - at
    // 59s the oldest entry is still inside the window.
    advance(500);
    const denied = limiter.takeBurst("hello");
    expect(denied).toEqual({
      ok: false,
      kind: "burst",
      retryAfterSec: APP_MESSAGE_BURST_WINDOW_MS / 1000,
    });
    if (!denied.ok) advance(denied.retryAfterSec * 1000);
    expect(limiter.takeBurst("hello").ok).toBe(true);
  });
});

describe("app-message limits: the daily budget", () => {
  // The two budgets are spent at DIFFERENT moments, and this is the reason the
  // limiter has two methods: a delivery the receiver refused burned no model
  // tokens, so it must not burn the app's day.
  it("is untouched by takeBurst alone - only a committed delivery spends it", () => {
    const { limiter, advance } = limiterAt();
    // Far more attempts than the daily cap, none of them committed, spread out
    // so the burst window never blocks.
    for (let i = 0; i < APP_MESSAGE_DAILY_CAP + 10; i++) {
      expect({ i, ok: limiter.takeBurst("hello").ok }).toEqual({ i, ok: true });
      advance(APP_MESSAGE_BURST_WINDOW_MS);
    }
    // Still nothing spent, so the next attempt is fine.
    expect(limiter.takeBurst("hello").ok).toBe(true);
  });

  it("refuses once the cap is committed, and says how long the rolling day has left", () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < APP_MESSAGE_DAILY_CAP; i++) {
      limiter.commitDaily("hello");
    }
    // An hour later the oldest commit still has 23 hours to age out.
    advance(60 * 60 * 1000);
    expect(limiter.takeBurst("hello")).toEqual({
      ok: false,
      kind: "daily",
      retryAfterSec: APP_MESSAGE_DAILY_WINDOW_MS / 1000 - 3600,
    });
  });

  it("rolls: the oldest commit ageing out returns exactly one message", () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < APP_MESSAGE_DAILY_CAP; i++) {
      limiter.commitDaily("hello");
      advance(1000);
    }
    const denied = limiter.takeBurst("hello");
    expect(denied.ok).toBe(false);
    if (!denied.ok) advance(denied.retryAfterSec * 1000);
    expect(limiter.takeBurst("hello").ok).toBe(true);
    limiter.commitDaily("hello");
    // And the day is full again: only the one slot came back.
    expect(limiter.takeBurst("hello").ok).toBe(false);
  });

  it("is per app", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < APP_MESSAGE_DAILY_CAP; i++)
      limiter.commitDaily("noisy");
    expect(limiter.takeBurst("noisy").ok).toBe(false);
    expect(limiter.takeBurst("quiet").ok).toBe(true);
  });
});

describe("app-message limits: when BOTH budgets block", () => {
  // The whole reason both waits are computed. Telling a caller "retry in 60s"
  // while the rolling day blocks for another 23 hours is advice that produces
  // exactly the retry loop these limits exist to stop - so the answer is always
  // the longer of the two, named by whichever limit that is.
  it("reports the daily wait when the day is what will still be blocking", () => {
    const { limiter } = limiterAt();
    // Burst first, while the day still has room - the only order in which burst
    // entries can be recorded at all (takeBurst refuses once the day is full).
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      expect(limiter.takeBurst("hello").ok).toBe(true);
    }
    for (let i = 0; i < APP_MESSAGE_DAILY_CAP; i++)
      limiter.commitDaily("hello");
    // Both block now: 60s of burst against 24h of rolling day.
    expect(limiter.takeBurst("hello")).toEqual({
      ok: false,
      kind: "daily",
      retryAfterSec: APP_MESSAGE_DAILY_WINDOW_MS / 1000,
    });
  });

  it("reports the burst wait when the day is nearly through and the burst is fresh", () => {
    const { limiter, advance } = limiterAt();
    // Yesterday's traffic, five short of the cap.
    for (let i = 0; i < APP_MESSAGE_DAILY_CAP - APP_MESSAGE_BURST_LIMIT; i++) {
      limiter.commitDaily("hello");
    }
    // Nearly 24 hours later: the oldest commit is 40s from ageing out.
    advance(APP_MESSAGE_DAILY_WINDOW_MS - 40_000);
    // Five more messages, a second apart, the way the handler pairs the calls -
    // and the fifth fills the day.
    for (let i = 0; i < APP_MESSAGE_BURST_LIMIT; i++) {
      expect({ i, ok: limiter.takeBurst("hello").ok }).toEqual({ i, ok: true });
      limiter.commitDaily("hello");
      advance(1000);
    }
    // Day: 40s - 5s elapsed = 35s left. Burst: the oldest of the five is 5s old,
    // so 55s left. The longer one wins, and it is the burst this time.
    const denied = limiter.takeBurst("hello");
    expect(denied).toEqual({ ok: false, kind: "burst", retryAfterSec: 55 });
    // And it is honest: waiting exactly that long lets a message through, which
    // the daily wait alone (35s) would not have.
    if (!denied.ok) advance(denied.retryAfterSec * 1000);
    expect(limiter.takeBurst("hello").ok).toBe(true);
  });
});
