import { describe, it, expect } from "bun:test";
import { pushStopArm, settleStopArm } from "./stop-notice-arms.ts";
import type { StopNoticeArm } from "./internal-types.ts";

const holder = (): { stopNotice: StopNoticeArm | null } => ({
  stopNotice: null,
});

function depth(arm: StopNoticeArm | null): number {
  let n = 0;
  for (let a = arm; a; a = a.backing) n++;
  return n;
}

describe("stop-notice arms", () => {
  it("clears the slot when concurrent arms all fail, in either order", () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const h = holder();
      const arms = [pushStopArm(h, "n"), pushStopArm(h, "n")];
      for (const i of order) settleStopArm(h, arms[i], false);
      expect(h.stopNotice).toBe(null);
    }
  });

  it("keeps a confirmed stop through failed arms on top of it", () => {
    const h = holder();
    settleStopArm(h, pushStopArm(h, "n"), true);
    const a = pushStopArm(h, "n");
    const b = pushStopArm(h, "n");
    settleStopArm(h, a, false);
    settleStopArm(h, b, false);
    expect(h.stopNotice).not.toBe(null);
  });

  it("keeps the slot bounded under repeated failures behind a confirmed stop", () => {
    const h = holder();
    settleStopArm(h, pushStopArm(h, "n"), true);
    for (let i = 0; i < 100; i++) {
      const arm = pushStopArm(h, "n");
      settleStopArm(h, arm, false);
      // The failed head stays only as a stand-in for the confirmed arm.
      expect(depth(h.stopNotice)).toBeLessThanOrEqual(2);
    }
    expect(h.stopNotice).not.toBe(null);
  });

  it("keeps the failed head object while a live arm is behind it", () => {
    // A send in progress compares the slot by identity at consumption.
    const h = holder();
    const pending = pushStopArm(h, "n");
    const head = pushStopArm(h, "n");
    settleStopArm(h, head, false);
    expect(h.stopNotice).toBe(head);
    settleStopArm(h, pending, false);
    expect(h.stopNotice).toBe(null);
  });

  it("drops the chain behind a confirmed arm", () => {
    const h = holder();
    const a = pushStopArm(h, "n");
    const b = pushStopArm(h, "n");
    settleStopArm(h, b, true);
    expect(depth(h.stopNotice)).toBe(1);
    settleStopArm(h, a, false);
    expect(h.stopNotice).toBe(b);
  });
});
