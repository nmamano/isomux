// Unit tests for the Slide Mode gate (ui/device-settings.ts). The gate is the
// global on/off switch above the per-agent deck pref: it defaults OFF, and
// flipping it must never disturb the per-agent prefs, so turning it back on
// restores whatever decks the viewer had open. localStorage is stubbed on
// globalThis - the module reads the global directly, like the rest of the
// device-scoped settings.

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
  getSlideModeEnabled,
  setSlideModeEnabled,
  subscribeSlideModeEnabled,
  getSlideView,
  setSlideView,
  getUsagePin,
  setUsagePin,
} = await import("./device-settings.ts");

describe("slide mode gate", () => {
  beforeEach(() => store.clear());

  it("defaults to off", () => {
    expect(getSlideModeEnabled()).toBe(false);
  });

  it("round-trips", () => {
    setSlideModeEnabled(true);
    expect(getSlideModeEnabled()).toBe(true);
    setSlideModeEnabled(false);
    expect(getSlideModeEnabled()).toBe(false);
  });

  it("treats an unknown stored value as off", () => {
    store.set("isomux-slide-mode", "yes");
    expect(getSlideModeEnabled()).toBe(false);
  });

  it("leaves the per-agent deck prefs alone", () => {
    setSlideView("agent-1", true);
    setSlideModeEnabled(true);
    setSlideModeEnabled(false);
    expect(getSlideView("agent-1")).toBe(true);
  });

  // The subscription is the whole reason a mounted chat view picks the gate up
  // when the settings modal saves over it, so it is part of the contract.
  it("notifies subscribers until they unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeSlideModeEnabled(() => calls++);
    setSlideModeEnabled(true);
    setSlideModeEnabled(false);
    expect(calls).toBe(2);
    unsubscribe();
    setSlideModeEnabled(true);
    expect(calls).toBe(2);
  });

  it("does not notify when the value did not change", () => {
    let calls = 0;
    const unsubscribe = subscribeSlideModeEnabled(() => calls++);
    setSlideModeEnabled(false);
    setSlideModeEnabled(true);
    setSlideModeEnabled(true);
    expect(calls).toBe(1);
    unsubscribe();
  });
});

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
