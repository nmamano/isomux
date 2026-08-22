// Unit tests for the device-scoped settings (ui/device-settings.ts).
// localStorage is stubbed on globalThis - the module reads the global
// directly.
//
// The Slide Mode GATE is no longer here: task 49d4e2f6 moved it to the user
// record so it follows a boss across devices. All that is left of it is the
// one-shot migration read, covered below.

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
  readLegacySlideMode,
  clearLegacySlideMode,
  getSlideView,
  setSlideView,
  getAppPreviews,
  setAppPreviews,
  APP_PREVIEW_OPEN_TTL_MS,
  getAppPreviewOpenedAt,
  markAppPreviewOpened,
  pruneAppPreviewOpens,
  getUsagePin,
  setUsagePin,
} = await import("./device-settings.ts");

describe("app previews", () => {
  beforeEach(() => store.clear());

  it("defaults on and round-trips this device's choice", () => {
    expect(getAppPreviews()).toBe(true);
    setAppPreviews(false);
    expect(getAppPreviews()).toBe(false);
    setAppPreviews(true);
    expect(getAppPreviews()).toBe(true);
  });

  it("remembers an exact app URL only for the app-session lifetime", () => {
    markAppPreviewOpened("https://habits.office.example", 1000);
    expect(getAppPreviewOpenedAt("https://habits.office.example", 1001)).toBe(
      1000,
    );
    expect(getAppPreviewOpenedAt("https://other.office.example", 1001)).toBe(
      null,
    );
    expect(
      getAppPreviewOpenedAt(
        "https://habits.office.example",
        1000 + APP_PREVIEW_OPEN_TTL_MS,
      ),
    ).toBe(null);
  });

  it("prunes open facts for apps that are no longer listed", () => {
    markAppPreviewOpened("https://keep.office.example", 1000);
    markAppPreviewOpened("https://gone.office.example", 1000);
    pruneAppPreviewOpens(["https://keep.office.example"]);
    expect(getAppPreviewOpenedAt("https://keep.office.example", 1001)).toBe(
      1000,
    );
    expect(getAppPreviewOpenedAt("https://gone.office.example", 1001)).toBe(
      null,
    );
  });

  it("does not rewrite the open facts when every listed app remains", () => {
    const raw = '{ "https://keep.office.example": 1000 }';
    store.set("isomux-app-preview-opens", raw);
    pruneAppPreviewOpens(["https://keep.office.example"]);
    expect(store.get("isomux-app-preview-opens")).toBe(raw);
  });
});

describe("legacy slide mode migration read", () => {
  beforeEach(() => store.clear());

  // null vs false is the whole point: null means this device never had the
  // setting (nothing to migrate), false means it was explicitly off (clear the
  // key, but do not turn the account-level preference off on its behalf).
  it("reports null when the key was never set", () => {
    expect(readLegacySlideMode()).toBe(null);
  });

  it("reports true only for the stored on-value", () => {
    store.set("isomux-slide-mode", "1");
    expect(readLegacySlideMode()).toBe(true);
  });

  it("treats any other stored value as off, not as absent", () => {
    store.set("isomux-slide-mode", "yes");
    expect(readLegacySlideMode()).toBe(false);
    store.set("isomux-slide-mode", "0");
    expect(readLegacySlideMode()).toBe(false);
  });

  it("clearing makes the device look like it never had the setting", () => {
    store.set("isomux-slide-mode", "1");
    clearLegacySlideMode();
    expect(readLegacySlideMode()).toBe(null);
  });

  it("leaves the per-agent deck prefs alone (still per device)", () => {
    setSlideView("agent-1", true);
    store.set("isomux-slide-mode", "1");
    clearLegacySlideMode();
    expect(getSlideView("agent-1")).toBe(true);
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
