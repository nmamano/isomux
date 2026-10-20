// readSafariEnv (ui/safari-link.ts) against the user agents iOS sends.
//
// Pins: the iOS major version comes from "OS <N>_"; iPadOS, which reports a
// Mac, has no version (null) but still counts as iOS, so its Home Screen app
// gets the Safari rewrite; a Mac's "Mac OS X 10_15_7" is never read as iOS 10.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { readSafariEnv } = await import("./safari-link.ts");
const { asDevice, IPHONE_17, IPHONE_HOME_SCREEN } =
  await import("./test-support/ios-home-screen.ts");

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IPHONE_16 = IPHONE_17.replace("OS 17_4", "OS 16_7");
const IPAD_MOBILE_18 =
  "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

for (const [label, device, env] of [
  [
    "iPhone Home Screen app",
    IPHONE_HOME_SCREEN,
    { ios: true, standalone: true, iosMajor: 17 },
  ],
  [
    "iPhone in Safari",
    { ...IPHONE_HOME_SCREEN, standalone: false },
    { ios: true, standalone: false, iosMajor: 17 },
  ],
  [
    "iPhone on iOS 16",
    { ...IPHONE_HOME_SCREEN, userAgent: IPHONE_16 },
    { ios: true, standalone: true, iosMajor: 16 },
  ],
  [
    "iPad with a mobile user agent",
    { ...IPHONE_HOME_SCREEN, userAgent: IPAD_MOBILE_18, platform: "iPad" },
    { ios: true, standalone: true, iosMajor: 18 },
  ],
  [
    "iPad reporting a Mac",
    {
      userAgent: MAC,
      platform: "MacIntel",
      maxTouchPoints: 5,
      standalone: true,
    },
    { ios: true, standalone: true, iosMajor: null },
  ],
  [
    "Mac",
    { userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 },
    { ios: false, standalone: false, iosMajor: null },
  ],
] as const) {
  it(`reads the ${label}`, () => {
    const undo = asDevice(device);
    try {
      expect(readSafariEnv()).toEqual(env);
    } finally {
      undo();
    }
  });
}
