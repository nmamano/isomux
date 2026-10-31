import { test, expect } from "bun:test";
import {
  extensionOutdated,
  officeSocketURL,
  validBrowserAccess,
  validGrantExpiry,
  validGrantScope,
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

// Task 7355640c: one access setting per browser says which agents may use it.
// The office and the extension both read it from a message or from storage.
test("an access setting has a known agents value, unique member ids within the caps, and an openTabs flag, and nothing else", () => {
  const id = (n: number) => "m" + n;
  for (const access of [
    { agents: "mine", members: [], openTabs: false },
    { agents: "members", members: ["m1", "m2"], openTabs: true },
    // The picks stay stored under the other values.
    { agents: "office", members: ["m1"], openTabs: false },
    { agents: "members", members: ["x".repeat(200)], openTabs: false },
    {
      agents: "members",
      members: Array.from({ length: 200 }, (_, n) => id(n)),
      openTabs: true,
    },
  ])
    expect({ access, valid: validBrowserAccess(access) }).toEqual({
      access,
      valid: true,
    });
  for (const access of [
    null,
    [],
    "mine",
    { agents: "all", members: [], openTabs: true },
    { agents: "everyone", members: [], openTabs: true },
    { agents: "mine", members: [], openTabs: "yes" },
    { agents: "mine", openTabs: true },
    { agents: "mine", members: [] },
    { members: [], openTabs: true },
    { agents: "members", members: "m1", openTabs: true },
    { agents: "members", members: ["m1", "m1"], openTabs: true },
    { agents: "members", members: [""], openTabs: true },
    { agents: "members", members: [1], openTabs: true },
    { agents: "members", members: ["x".repeat(201)], openTabs: true },
    {
      agents: "members",
      members: Array.from({ length: 201 }, (_, n) => id(n)),
      openTabs: true,
    },
    { agents: "mine", members: [], openTabs: true, extra: 1 },
  ])
    expect({ access, valid: validBrowserAccess(access) }).toEqual({
      access,
      valid: false,
    });
});

test("a shared offer scope has its kind and nothing else", () => {
  expect(validGrantScope({ kind: "shared" })).toBe(true);
  expect(validGrantScope({ kind: "shared", agentId: "a" })).toBe(false);
  expect(validGrantScope({ kind: "shared", via: "all" })).toBe(false);
});
