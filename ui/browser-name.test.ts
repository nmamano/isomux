// The default browser name on Integrations > Browser (ui/browser-name.ts).
//
// Pins: a desktop Chromium browser gets its browser and OS; Edge and Opera
// say Chrome in their user agent but keep their own name; a phone, an iPad
// that reports a Mac, and a browser that cannot load the extension get none.

import { describe, it, expect } from "bun:test";
import { guessBrowserName } from "./browser-name.ts";

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CHROME_OS =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/130.0.0.0`;
const OPERA_MAC = `${CHROME_MAC} OPR/114.0.0.0`;
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
const CHROME_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1";

describe("guessBrowserName", () => {
  it("names a desktop Chromium browser and its OS", () => {
    expect(guessBrowserName(CHROME_WINDOWS, "Win32", 0)).toEqual({
      browser: "Chrome",
      os: "Windows",
    });
    expect(guessBrowserName(CHROME_MAC, "MacIntel", 0)).toEqual({
      browser: "Chrome",
      os: "macOS",
    });
    expect(guessBrowserName(CHROME_LINUX, "Linux x86_64", 0)).toEqual({
      browser: "Chrome",
      os: "Linux",
    });
    expect(guessBrowserName(CHROME_OS, "Linux x86_64", 0)).toEqual({
      browser: "Chrome",
      os: "ChromeOS",
    });
    expect(guessBrowserName(EDGE_WINDOWS, "Win32", 0)).toEqual({
      browser: "Edge",
      os: "Windows",
    });
    expect(guessBrowserName(OPERA_MAC, "MacIntel", 0)).toEqual({
      browser: "Opera",
      os: "macOS",
    });
  });

  it("names nothing on a phone, a tablet or a browser without the extension", () => {
    expect(guessBrowserName(CHROME_ANDROID, "Linux armv8l", 5)).toBeNull();
    expect(guessBrowserName(CHROME_IPHONE, "iPhone", 5)).toBeNull();
    // iPadOS reports a Mac with touch points.
    expect(guessBrowserName(CHROME_MAC, "MacIntel", 5)).toBeNull();
    expect(guessBrowserName(SAFARI_MAC, "MacIntel", 0)).toBeNull();
    expect(guessBrowserName(FIREFOX_WINDOWS, "Win32", 0)).toBeNull();
  });
});
