import { test, expect } from "bun:test";
import {
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
