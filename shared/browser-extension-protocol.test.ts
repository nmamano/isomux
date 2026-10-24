import { test, expect } from "bun:test";
import { officeSocketURL } from "./browser-extension-protocol";

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
