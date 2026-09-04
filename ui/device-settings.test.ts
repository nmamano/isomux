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
