// Unit tests for the device-scoped settings (ui/device-settings.ts).
// localStorage is stubbed on globalThis - the module reads the global
// directly.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";

const store = new Map<string, string>();
const realLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});

afterAll(() => {
  if (realLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", realLocalStorage);
  } else {
    // @ts-expect-error - removing the stub we installed
    delete globalThis.localStorage;
  }
});

const {
  getMembersChatHidden,
  getMembersChatWidth,
  setMembersChatWidth,
  getUsagePin,
  setUsagePin,
  getRoomFilter,
  setRoomFilter,
} = await import("./device-settings.ts");

// The usage pill's pinned limit (task df489513). Stored per device per agent
// AND per provider: an agent switched between engines must not stay pinned to a
// window the new provider doesn't have.
describe("usage pill pin", () => {
  beforeEach(() => store.clear());

  const weekly = { label: "Weekly", index: 0 };
  const fiveHour = { label: "5-hour", index: 1 };

  it("defaults to auto (no pin)", () => {
    expect(getUsagePin("agent-1", "claude")).toBeNull();
  });

  it("round-trips a pinned window", () => {
    setUsagePin("agent-1", "claude", fiveHour);
    expect(getUsagePin("agent-1", "claude")).toEqual(fiveHour);
  });

  it("keeps agents and providers apart", () => {
    setUsagePin("agent-1", "claude", { label: "Weekly (Opus)", index: 2 });
    setUsagePin("agent-2", "claude", fiveHour);
    // Same agent, other engine: a Claude window label means nothing to Codex.
    expect(getUsagePin("agent-1", "codex")).toBeNull();
    expect(getUsagePin("agent-2", "claude")).toEqual(fiveHour);
    expect(getUsagePin("agent-1", "claude")).toEqual({
      label: "Weekly (Opus)",
      index: 2,
    });
  });

  it("clears back to auto with null, leaving other pins alone", () => {
    setUsagePin("agent-1", "claude", fiveHour);
    setUsagePin("agent-2", "claude", weekly);
    setUsagePin("agent-1", "claude", null);
    expect(getUsagePin("agent-1", "claude")).toBeNull();
    expect(getUsagePin("agent-2", "claude")).toEqual(weekly);
  });

  it("survives a corrupt stored value instead of throwing", () => {
    store.set("isomux-usage-pin", "{not json");
    expect(getUsagePin("agent-1", "claude")).toBeNull();
    setUsagePin("agent-1", "claude", weekly);
    expect(getUsagePin("agent-1", "claude")).toEqual(weekly);
  });

  it("rejects a stored entry of the wrong shape rather than half-trusting it", () => {
    store.set(
      "isomux-usage-pin",
      JSON.stringify({
        "claude:agent-1": "Weekly",
        "claude:agent-2": { label: "Weekly" },
        "claude:agent-3": { index: 1 },
      }),
    );
    expect(getUsagePin("agent-1", "claude")).toBeNull();
    expect(getUsagePin("agent-2", "claude")).toBeNull();
    expect(getUsagePin("agent-3", "claude")).toBeNull();
  });
});

describe("members chat width", () => {
  beforeEach(() => store.clear());
  it("defaults missing and invalid values, clamps finite values, and remembers width", () => {
    expect(getMembersChatWidth(1440)).toBe(520);
    for (const value of ["broken", "NaN", "Infinity", ""]) {
      store.set("isomux-members-chat-width", value);
      expect(getMembersChatWidth(1440)).toBe(520);
    }
    store.set("isomux-members-chat-width", "-900");
    expect(getMembersChatWidth(1440)).toBe(300);
    setMembersChatWidth(800);
    expect(getMembersChatWidth(1440)).toBe(800);
    expect(getMembersChatWidth(768)).toBe(720);
    setMembersChatWidth(90000);
    expect(getMembersChatWidth(1440)).toBe(900);
  });
});

it("reads a missing or unknown desktop chat visibility value as no saved choice", () => {
  store.delete("isomux-members-chat-hidden");
  expect(getMembersChatHidden()).toBe(null);
  store.set("isomux-members-chat-hidden", "broken");
  expect(getMembersChatHidden()).toBe(null);
  store.set("isomux-members-chat-hidden", "true");
  expect(getMembersChatHidden()).toBe(true);
  store.set("isomux-members-chat-hidden", "false");
  expect(getMembersChatHidden()).toBe(false);
});

describe("room filters", () => {
  beforeEach(() => store.clear());
  it("default to all rooms and remember each page's choice apart", () => {
    expect(getRoomFilter("apps")).toBe("all");
    expect(getRoomFilter("schedules")).toBe("all");
    setRoomFilter("schedules", "a1b2c3d4");
    setRoomFilter("apps", "none");
    expect(getRoomFilter("schedules")).toBe("a1b2c3d4");
    expect(getRoomFilter("apps")).toBe("none");
    setRoomFilter("schedules", "all");
    expect(getRoomFilter("schedules")).toBe("all");
  });
});
