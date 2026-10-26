import { test, expect } from "bun:test";
import {
  extensionOutdated,
  officeSocketURL,
  validGrantExpiry,
} from "./browser-extension-protocol";

test("office URL input accepts origins only and derives the encrypted socket", () => {
  expect(officeSocketURL("https://office.example.com")).toBe(
    "wss://office.example.com/browser-extension/ws",
  );
  expect(officeSocketURL("http://localhost:1234/")).toBe(
    "ws://localhost:1234/browser-extension/ws",
  );
  for (const value of [
    "https://user:secret@office.example.com",
    "https://office.example.com/?secret=a",
    "https://office.example.com/#token",
    "https://office.example.com/?",
    "https://office.example.com/#",
    "https://office.example.com/browser-extension/ws",
    "http://office.example.com",
    "wss://office.example.com",
  ])
    expect(() => officeSocketURL(value)).toThrow();
});

test("a grant expiry is null exactly for Never and otherwise a valid Date time", () => {
  const latest = 8_640_000_000_000_000;
  for (const [duration, expiresAt] of [
    [0, null],
    [15, 1_800_000_000_000],
    [240, latest],
  ])
    expect(validGrantExpiry(duration, expiresAt)).toBe(true);
  for (const [duration, expiresAt] of [
    [undefined, undefined],
    [0, 1_800_000_000_000],
    [15, null],
    [1, 1_800_000_000_000],
    [15, 0],
    [15, 1.5],
    [15, latest + 1],
    [15, "1800000000000"],
  ])
    expect(validGrantExpiry(duration, expiresAt)).toBe(false);
});

// Task 825bb286: the office tells the member to update an extension older
// than its own package. Versions compare as numbers, part by part.
test("an extension is out of date exactly when its package is older than the office's, or it reported none", () => {
  for (const [reported, latest] of [
    ["0.4.9", "0.4.10"],
    ["0.4.4", "0.4.5"],
    ["0.4", "0.4.1"],
    ["0.9.9", "1.0"],
    [null, "0.4.5"],
  ] as const)
    expect(extensionOutdated(reported, latest)).toBe(true);
  for (const [reported, latest] of [
    ["0.4.10", "0.4.9"],
    ["0.4.5", "0.4.5"],
    ["0.4", "0.4.0"],
    ["1.0", "0.9.9"],
    // Not seen this server run: nothing is known, so no notice.
    [undefined, "0.4.5"],
  ] as const)
    expect(extensionOutdated(reported, latest)).toBe(false);
});
