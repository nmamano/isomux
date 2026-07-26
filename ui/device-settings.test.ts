// Unit tests for the Slide Mode gate (ui/device-settings.ts). The gate is the
// global on/off switch above the per-agent deck pref: it defaults OFF, and
// flipping it must never disturb the per-agent prefs, so turning it back on
// restores whatever decks the viewer had open. localStorage is stubbed on
// globalThis — the module reads the global directly, like the rest of the
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
    // @ts-expect-error — removing the stub we installed
    delete globalThis.localStorage;
  }
});

const {
  getSlideModeEnabled,
  setSlideModeEnabled,
  subscribeSlideModeEnabled,
  getSlideView,
  setSlideView,
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
