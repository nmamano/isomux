// Which browsers can turn on pager pushes (ui/push-subscription.ts).
//
// Pins: iOS offers push only to a site opened from the Home Screen, so an
// iPhone or iPad in Safari gets the install hint whatever it reports; iPadOS
// reporting a Mac is still iOS; a browser without the push APIs is
// unsupported.

import { describe, it, expect } from "bun:test";
import {
  guessDeviceLabel,
  isIos,
  pushSupport,
  type PushEnv,
} from "./push-subscription.ts";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const env = (over: Partial<PushEnv>): PushEnv => ({
  hasPush: true,
  userAgent: MAC,
  platform: "MacIntel",
  maxTouchPoints: 0,
  standalone: false,
  ...over,
});

describe("pushSupport", () => {
  it("asks iOS outside the Home Screen app to install first", () => {
    expect(
      pushSupport(
        env({ userAgent: IPHONE, platform: "iPhone", hasPush: false }),
      ),
    ).toBe("ios-install");
    // iPadOS reports a Mac with touch points.
    expect(isIos(env({ maxTouchPoints: 5 }))).toBe(true);
    expect(pushSupport(env({ maxTouchPoints: 5 }))).toBe("ios-install");
  });

  it("allows the Home Screen app and desktop browsers with the push APIs", () => {
    expect(
      pushSupport(
        env({ userAgent: IPHONE, platform: "iPhone", standalone: true }),
      ),
    ).toBe("ok");
    expect(pushSupport(env({}))).toBe("ok");
  });

  it("calls a browser without the push APIs unsupported", () => {
    expect(pushSupport(env({ hasPush: false }))).toBe("unsupported");
    // An old iOS Home Screen app has no push either.
    expect(
      pushSupport(
        env({
          userAgent: IPHONE,
          platform: "iPhone",
          standalone: true,
          hasPush: false,
        }),
      ),
    ).toBe("unsupported");
  });
});

describe("guessDeviceLabel", () => {
  it("names the device kind", () => {
    expect(
      guessDeviceLabel(env({ userAgent: IPHONE, platform: "iPhone" })),
    ).toBe("iPhone");
    expect(guessDeviceLabel(env({ maxTouchPoints: 5 }))).toBe("iPad");
    expect(guessDeviceLabel(env({}))).toBe("Mac");
    expect(
      guessDeviceLabel(
        env({ userAgent: "x Android y", platform: "Linux armv8l" }),
      ),
    ).toBe("Android");
  });
});
