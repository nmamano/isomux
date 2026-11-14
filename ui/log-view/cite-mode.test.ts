// Where the chat's Cite pill goes on each device (task fe7db5ac). Nil,
// 2026-11-14: "better not to have it than to have a janky version".
//
// Pins: a mouse or trackpad keeps the pill next to the selection, whatever the
// device reports; on iOS and iPadOS touch the pill is pinned to a corner,
// away from the native selection menu and handles; every other touch
// platform has no Cite until someone proves it on a real device.

import { describe, expect, it } from "bun:test";
import { citeMode, type CiteEnv, type CiteMode } from "./cite-mode.ts";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// iPadOS Safari asks for the desktop site: it reports a Mac.
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const cases: Array<[string, CiteEnv, CiteMode]> = [
  [
    "a desktop with a mouse",
    {
      coarsePointer: false,
      userAgent: MAC,
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
    "anchored",
  ],
  [
    "an iPad with a trackpad (the pointer wins over the platform)",
    {
      coarsePointer: false,
      userAgent: MAC,
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
    "anchored",
  ],
  [
    "an iPhone",
    {
      coarsePointer: true,
      userAgent: IPHONE,
      platform: "iPhone",
      maxTouchPoints: 5,
    },
    "pinned",
  ],
  [
    "an iPad that reports a Mac",
    {
      coarsePointer: true,
      userAgent: MAC,
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
    "pinned",
  ],
  [
    "an Android phone",
    {
      coarsePointer: true,
      userAgent: ANDROID,
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    },
    null,
  ],
  [
    "an unknown touch device",
    {
      coarsePointer: true,
      userAgent: "Mozilla/5.0",
      platform: "",
      maxTouchPoints: 1,
    },
    null,
  ],
];

describe("citeMode", () => {
  for (const [name, env, mode] of cases)
    it(`${name}: ${String(mode)}`, () => {
      expect(citeMode(env)).toBe(mode);
    });
});
